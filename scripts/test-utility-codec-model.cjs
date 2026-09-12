#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const filename = path.join(root, 'frontend/src/toolbox/utilityCodecModel.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { CODEC_INPUT_LIMIT, textMetrics, codecModes, codecSample, formatHexOutput } = loaded.exports;

test('counts Unicode code points and UTF-8 bytes independently', () => {
  assert.deepEqual(textMetrics('云依🙂'), { characters: 3, lines: 1, bytes: 10 });
  assert.deepEqual(textMetrics(''), { characters: 0, lines: 0, bytes: 0 });
  assert.deepEqual(textMetrics('e\u0301'), { characters: 2, lines: 1, bytes: 3 });
});
test('CRLF is one line break; trailing and mixed newlines are retained', () => {
  assert.deepEqual(textMetrics('a\r\nb\rc\n'), { characters: 7, lines: 4, bytes: 7 });
  assert.equal(textMetrics('\r\n').lines, 2);
});
test('input cap is in bytes, not visible characters', () => {
  assert.equal(CODEC_INPUT_LIMIT, 1048576);
  assert.ok(textMetrics('云'.repeat(350000)).bytes > CODEC_INPUT_LIMIT);
});
test('Hex display toggles never alter bytes including zero', () => {
  for (const upper of [false, true]) for (const spaces of [false, true]) {
    const result = formatHexOutput('00abcdef09', upper, spaces);
    assert.equal(result.replace(/ /g, '').toLowerCase(), '00abcdef09');
    assert.equal(result.includes(' '), spaces);
    assert.equal(formatHexOutput('', upper, spaces), '');
  }
  assert.equal(formatHexOutput('00ab', true, true), '00 AB');
});
test('mode choices match existing native operations', () => {
  assert.deepEqual(codecModes('url-encode').map(x => x.id), ['encode-component', 'encode-url', 'decode']);
  assert.deepEqual(codecModes('hash').map(x => x.id), ['sha256', 'md5']);
  assert.deepEqual(codecModes('json-format').map(x => x.id), ['format', 'minify']);
  assert.deepEqual(codecModes('base64').map(x => x.id), ['encode', 'decode']);
});
test('decode examples are valid UTF-8 in each advertised format', () => {
  assert.equal(Buffer.from(codecSample('base64', 'decode'), 'base64').toString('utf8'), '云依助手');
  assert.equal(Buffer.from(codecSample('hex', 'decode').replace(/ /g, ''), 'hex').toString('utf8'), '云依助手');
  assert.equal(decodeURIComponent(codecSample('url-encode', 'decode')), '云依助手');
  assert.equal(JSON.parse(codecSample('json-format', 'format')).enabled, true);
});
