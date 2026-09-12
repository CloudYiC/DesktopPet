#!/usr/bin/env node
'use strict';

// Run with node scripts/test-text-diff-model.cjs. Compilation stays in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const ts = require(path.join(projectRoot, 'frontend/node_modules/typescript'));
const filename = path.join(projectRoot, 'frontend/src/toolbox/textDiffModel.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { compareTexts } = loaded.exports;

const lines = (text) => text === '' ? [] : text.split(/\r\n|\n|\r/u);
const kinds = (result) => result.rows.map((row) => row.kind);
const changedText = (line) => line.segments.filter((part) => part.changed).map((part) => part.text).join('');

function validate(result, left, right, options = {}) {
  for (const [side, input] of [['left', left], ['right', right]]) {
    const visible = result.rows.flatMap((row) => row[side] ? [row[side]] : []);
    assert.deepEqual(visible.map((line) => line.text), lines(input), `${side} content reconstructs`);
    assert.deepEqual(visible.map((line) => line.lineNumber), visible.map((_, index) => index + 1));
    for (const line of visible) {
      assert.equal(line.segments.map((part) => part.text).join(''), line.text, 'segments reconstruct');
      for (const segment of line.segments) {
        assert.equal(typeof segment.changed, 'boolean');
        // Fixtures contain valid Unicode; segmentation must never create a lone surrogate.
        assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(segment.text), false);
      }
    }
  }
  const expectedStats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const expectedGroups = [];
  result.rows.forEach((row, index) => {
    if (row.kind === 'same') {
      expectedStats.unchanged += 1;
      assert.ok(row.left && row.right);
      const key = (value) => options.ignoreWhitespace ? value.trim() : value;
      assert.equal(key(row.left.text), key(row.right.text));
      assert.ok([...row.left.segments, ...row.right.segments].every((part) => !part.changed));
      return;
    }
    if (row.kind === 'add') {
      expectedStats.added += 1;
      assert.equal(row.left, null);
      assert.ok(row.right);
    } else if (row.kind === 'remove') {
      expectedStats.removed += 1;
      assert.equal(row.right, null);
      assert.ok(row.left);
    } else {
      assert.equal(row.kind, 'change');
      expectedStats.modified += 1;
      assert.ok(row.left && row.right);
    }
    const last = expectedGroups.at(-1);
    if (last && last.endRow === index - 1) last.endRow = index;
    else expectedGroups.push({ startRow: index, endRow: index });
  });
  assert.deepEqual(result.stats, expectedStats);
  assert.deepEqual(result.groups, expectedGroups);
  assert.equal(result.identical, expectedGroups.length === 0);
}

test('empty inputs contain no phantom lines', () => {
  const result = compareTexts('', '');
  assert.deepEqual(result, {
    rows: [], groups: [], stats: { added: 0, removed: 0, modified: 0, unchanged: 0 }, identical: true,
  });
});

test('identical lines preserve display, line numbers and unchanged segments', () => {
  const input = '第一行 😀\n  second\n\nlast\n';
  const result = compareTexts(input, input);
  validate(result, input, input);
  assert.equal(result.identical, true);
  assert.equal(result.stats.unchanged, 5);
  assert.equal(result.notice, undefined);
});

test('insertions and removals align surrounding equal lines', () => {
  const left = 'first\nsecond\nlast';
  const right = 'first\ninserted\nsecond\nlast';
  const result = compareTexts(left, right);
  assert.deepEqual(kinds(result), ['same', 'add', 'same', 'same']);
  assert.deepEqual(result.groups, [{ startRow: 1, endRow: 1 }]);
  validate(result, left, right);
  const reverse = compareTexts(right, left);
  assert.deepEqual(kinds(reverse), ['same', 'remove', 'same', 'same']);
  validate(reverse, right, left);
});

test('replacement runs pair modifications and count only unpaired additions', () => {
  const left = 'top\nold A\nold B\nbottom';
  const right = 'top\nnew X\nnew Y\nnew Z\nbottom';
  const result = compareTexts(left, right);
  assert.deepEqual(kinds(result), ['same', 'change', 'change', 'add', 'same']);
  assert.deepEqual(result.stats, { added: 1, removed: 0, modified: 2, unchanged: 2 });
  assert.deepEqual(result.groups, [{ startRow: 1, endRow: 3 }]);
  validate(result, left, right);
});

test('multiple separated differences produce zero-based inclusive groups', () => {
  const left = 'old\nanchor\nremoved\nend\nfinal old';
  const right = 'new\nanchor\nend\nfinal new';
  const result = compareTexts(left, right);
  assert.deepEqual(kinds(result), ['change', 'same', 'remove', 'same', 'change']);
  assert.deepEqual(result.groups, [
    { startRow: 0, endRow: 0 }, { startRow: 2, endRow: 2 }, { startRow: 4, endRow: 4 },
  ]);
  validate(result, left, right);
});

test('repeated lines are matched in order without losing duplicates', () => {
  const left = 'A\nB\nA\nB\nA';
  const right = 'A\nB\nB\nA';
  const result = compareTexts(left, right);
  assert.deepEqual(kinds(result), ['same', 'same', 'remove', 'same', 'same']);
  assert.equal(result.notice, undefined);
  validate(result, left, right);
});

test('newline conventions normalize but a terminal newline remains a visible extra line', () => {
  const normalized = compareTexts('a\r\nb\rc\n', 'a\nb\nc\n');
  assert.equal(normalized.identical, true);
  validate(normalized, 'a\r\nb\rc\n', 'a\nb\nc\n');
  const ending = compareTexts('a', 'a\r\n');
  assert.deepEqual(kinds(ending), ['same', 'add']);
  assert.equal(ending.rows[1].right.text, '');
  assert.equal(ending.rows[1].right.lineNumber, 2);
  validate(ending, 'a', 'a\r\n');
  assert.deepEqual(kinds(compareTexts('', '\n')), ['add', 'add']);
  assert.deepEqual(kinds(compareTexts('\n', '')), ['remove', 'remove']);
});

test('whitespace option ignores only per-line leading and trailing whitespace', () => {
  const options = { ignoreWhitespace: true };
  const left = '  hello\t\n\t\n x y  ';
  const right = 'hello\n  \nx y';
  const result = compareTexts(left, right, options);
  assert.equal(result.identical, true);
  validate(result, left, right, options);
  assert.equal(compareTexts(left, right).identical, false);
  assert.equal(compareTexts('x y', 'x  y', options).identical, false);
  assert.equal(compareTexts('x', 'x\n', options).identical, false);
  assert.equal(compareTexts('', ' ', options).identical, false);
});

test('ignored edge whitespace is unhighlighted even on a changed line', () => {
  const options = { ignoreWhitespace: true };
  const left = '  用户旧名\t';
  const right = '\t用户新名  ';
  const result = compareTexts(left, right, options);
  validate(result, left, right, options);
  assert.equal(changedText(result.rows[0].left), '旧');
  assert.equal(changedText(result.rows[0].right), '新');
});

test('inline comparison highlights separate changes with equal text between them', () => {
  const left = 'alpha OLD middle BAD omega';
  const right = 'alpha NEW middle GOOD omega';
  const result = compareTexts(left, right);
  validate(result, left, right);
  assert.equal(result.rows[0].left.segments.find((part) => part.text.includes(' middle ')).changed, false);
  assert.equal(changedText(result.rows[0].left), 'OLDBA');
  assert.equal(changedText(result.rows[0].right), 'NEWGOO');
});

test('inline Chinese and emoji boundaries are Unicode code points, never half a surrogate', () => {
  const left = '你好😀，今天🌞真棒';
  const right = '您好😁，今天🌞很棒';
  const result = compareTexts(left, right);
  validate(result, left, right);
  assert.equal(changedText(result.rows[0].left), '你😀真');
  assert.equal(changedText(result.rows[0].right), '您😁很');
  const inserted = compareTexts('头尾', '头🚀尾');
  assert.equal(changedText(inserted.rows[0].left), '');
  assert.equal(changedText(inserted.rows[0].right), '🚀');
  validate(inserted, '头尾', '头🚀尾');
});

function lcsLength(left, right) {
  const previous = Array(right.length + 1).fill(0);
  for (const item of left) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = item === right[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[right.length];
}

test('600 deterministic randomized cases reconstruct both inputs and match exact LCS line counts', () => {
  let seed = 0x721fee;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const vocabulary = ['A', 'B', '重复', '😀', '', '  A ', '\tB', '中文🦊'];
  for (let iteration = 0; iteration < 600; iteration += 1) {
    const generate = () => Array.from({ length: random(18) }, () => vocabulary[random(vocabulary.length)])
      .join(random(2) ? '\n' : '\r\n');
    const left = generate();
    const right = generate();
    const options = { ignoreWhitespace: random(2) === 0 };
    const result = compareTexts(left, right, options);
    validate(result, left, right, options);
    const key = (value) => options.ignoreWhitespace ? value.trim() : value;
    assert.equal(result.stats.unchanged, lcsLength(lines(left).map(key), lines(right).map(key)));
    assert.equal(result.notice, undefined);
  }
});

test('300 randomized Unicode lines preserve the maximum shared code-point subsequence', () => {
  let seed = 0x194b31;
  const random = (max) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  const alphabet = ['A', 'B', '甲', '乙', '😀', '🦊', ' '];
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const generate = () => Array.from({ length: random(22) + 1 }, () => alphabet[random(alphabet.length)]).join('');
    const left = generate();
    const right = generate();
    const result = compareTexts(left, right);
    validate(result, left, right);
    const expectedShared = lcsLength(Array.from(left), Array.from(right));
    for (const side of ['left', 'right']) {
      const sharedText = result.rows[0][side].segments.filter((part) => !part.changed).map((part) => part.text).join('');
      assert.equal(Array.from(sharedText).length, expectedShared);
    }
  }
});

test('3000 entirely replaced lines use an explicit bounded fallback without truncation', () => {
  const left = Array.from({ length: 3000 }, (_, i) => `left-${i}-${'A'.repeat(45)}`).join('\n');
  const right = Array.from({ length: 3000 }, (_, i) => `right-${i}-${'B'.repeat(45)}`).join('\n');
  const started = performance.now();
  const result = compareTexts(left, right);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `bounded diff took ${elapsed.toFixed(1)} ms`);
  assert.match(result.notice, /简化对齐/);
  assert.equal(result.rows.length, 3000);
  assert.equal(result.stats.modified, 3000);
  validate(result, left, right);
});

test('patience fallback preserves unique anchors within a large rewrite', () => {
  const left = Array.from({ length: 3000 }, (_, i) => i % 10 === 5 ? `anchor-${i}` : `left-${i}`).join('\n');
  const right = Array.from({ length: 3000 }, (_, i) => i % 10 === 5 ? `anchor-${i}` : `right-${i}`).join('\n');
  const result = compareTexts(left, right);
  assert.match(result.notice, /简化对齐/);
  assert.equal(result.stats.unchanged, 300);
  assert.equal(result.stats.modified, 2700);
  validate(result, left, right);
});

test('near-identical maximum-length emoji lines retain precise highlight with linear prefix work', () => {
  const prefix = '😀'.repeat(49_998);
  const suffix = '🦊'.repeat(49_998);
  const left = `${prefix}旧${suffix}`;
  const right = `${prefix}新${suffix}`;
  const started = performance.now();
  const result = compareTexts(left, right);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `long-line diff took ${elapsed.toFixed(1)} ms`);
  assert.equal(result.notice, undefined);
  assert.equal(changedText(result.rows[0].left), '旧');
  assert.equal(changedText(result.rows[0].right), '新');
  validate(result, left, right);
});

test('200k-character unrelated lines fall back to a continuous highlight in bounded time', () => {
  const left = 'a'.repeat(200_000);
  const right = 'b'.repeat(200_000);
  const started = performance.now();
  const result = compareTexts(left, right);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `unrelated long-line diff took ${elapsed.toFixed(1)} ms`);
  assert.match(result.notice, /区段高亮/);
  assert.deepEqual(result.rows[0].left.segments, [{ text: left, changed: true }]);
  assert.deepEqual(result.rows[0].right.segments, [{ text: right, changed: true }]);
  validate(result, left, right);
});
