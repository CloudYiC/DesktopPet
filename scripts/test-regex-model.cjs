#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const file = path.join(root, 'frontend/src/toolbox/regexModel.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = new Module(file, module);
loaded.filename = file;
loaded._compile(compiled, file);
const { executeRegex, validateRegexInput, REGEX_LIMITS } = loaded.exports;
const run = (pattern, text, flags = 'g') => executeRegex({ pattern, flags, text });

test('global matches preserve content and UTF-16 positions', () => {
  const result = run('云依', '欢迎云依，再见云依');
  assert.deepEqual(result.matches.map(({ text, start, end }) => ({ text, start, end })), [
    { text: '云依', start: 2, end: 4 }, { text: '云依', start: 7, end: 9 },
  ]);
  assert.equal(result.limited, false);
});
test('non-global expressions return a single match without forcing g', () => {
  assert.equal(run('a', 'aaa', '').matches.length, 1);
});
test('empty global matches advance and include the end boundary', () => {
  assert.deepEqual(run('', 'ab').matches.map((m) => m.start), [0, 1, 2]);
});
test('unicode empty matches advance over surrogate pairs', () => {
  assert.deepEqual(run('(?:)', '😀a', 'gu').matches.map((m) => m.start), [0, 2, 3]);
  assert.deepEqual(run('(?:)', '😀a', 'g').matches.map((m) => m.start), [0, 1, 2, 3]);
});
test('empty text still supports zero-length matches', () => {
  assert.equal(run('^$', '').matches.length, 1);
});
test('sticky mode honors lastIndex continuity', () => {
  assert.deepEqual(run('a', 'aa ba', 'gy').matches.map((m) => m.start), [0, 1]);
  assert.equal(run('b', 'ab', 'y').matches.length, 0);
});
test('named and numbered capture groups preserve missing versus empty', () => {
  const m = run('(?<name>云依)(x)?()', '云依').matches[0];
  assert.deepEqual(m.groups, [
    { name: '1', value: '云依', truncated: false },
    { name: '2', value: null, truncated: false },
    { name: '3', value: '', truncated: false },
    { name: 'name', value: '云依', truncated: false },
  ]);
});
test('case, multiline, dotAll and unicode flags work', () => {
  assert.equal(run('^a.+b$', 'A\nxB', 'ims').matches[0].text, 'A\nxB');
  assert.equal(run('\\p{Script=Han}+', 'A中文', 'gu').matches[0].text, '中文');
});
test('lookaround matches retain original offsets', () => {
  assert.deepEqual(run('(?<=ID:)\\d+(?=;)', 'ID:123;').matches.map((m) => [m.text, m.start, m.end]), [['123', 3, 6]]);
});
test('unknown, duplicate, slash and whitespace flags are rejected clearly', () => {
  for (const flags of ['gg', 'z', '/g', 'g i', 'd']) assert.ok(validateRegexInput({ flags, pattern: 'a', text: 'a' }));
});
test('invalid regex syntax throws and does not silently return zero matches', () => {
  assert.throws(() => run('[', 'hello'));
});
test('input bounds reject rather than silently truncate text', () => {
  assert.throws(() => run('a', 'x'.repeat(REGEX_LIMITS.text + 1)), /200,000/);
  assert.throws(() => run('x'.repeat(REGEX_LIMITS.pattern + 1), 'x'), /4,096/);
});
test('large match counts are bounded and disclose truncation', () => {
  const result = run('a', 'a'.repeat(REGEX_LIMITS.matches + 1));
  assert.equal(result.matches.length, 1000);
  assert.equal(result.limited, true);
  assert.equal(run('a', 'a'.repeat(1000)).limited, false);
});
test('overlapping capture output stays bounded', () => {
  const result = run('(?=(a+))', 'a'.repeat(10000));
  const output = result.matches.reduce((sum, match) => sum + match.text.length + match.groups.reduce((count, group) => count + (group.value?.length || 0), 0), 0);
  assert.ok(output <= REGEX_LIMITS.output);
  assert.ok(result.matches[0].groups[0].truncated);
});
test('capture group count is bounded with visible truncation metadata', () => {
  const m = run('()'.repeat(40), '').matches[0];
  assert.equal(m.groups.length, 32);
  assert.equal(m.groupsTruncated, true);
});
test('a pathological expression is isolated in a terminable worker', async () => {
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const exports = {}; new Function('exports', workerData.compiled)(exports); parentPort.postMessage('ready'); exports.executeRegex({pattern:'(a+)+$',flags:'',text:'a'.repeat(40)+'!'}); parentPort.postMessage('done');`, { eval: true, workerData: { compiled } });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = await worker.terminate();
  assert.equal(stopped, 1);
});
