#!/usr/bin/env node
'use strict';

// Pure model checks: compile in memory without touching release assets or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const filename = path.join(root, 'frontend/src/toolbox/utilitySpecializedModel.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { boundedInteger, timestampMilliseconds, unixSecondsText, localDateText } = loaded.exports;

test('UUID and password bounds accept both edges without rounding', () => {
  for (const [minimum, maximum, label] of [[1, 50, 'UUID 数量'], [4, 128, '密码长度']]) {
    assert.equal(boundedInteger(String(minimum), minimum, maximum, label), minimum);
    assert.equal(boundedInteger(` ${maximum} `, minimum, maximum, label), maximum);
    for (const value of ['', ' ', '1.5', '5e1', '0x10', '12abc', '+5', String(minimum - 1), String(maximum + 1), '9007199254740993']) {
      assert.throws(() => boundedInteger(value, minimum, maximum, label));
    }
  }
});

test('timestamp unit is explicit; integers are normalized without inferring digits', () => {
  assert.equal(timestampMilliseconds('0', 'seconds'), 0);
  assert.equal(timestampMilliseconds('1704067200', 'seconds'), 1704067200000);
  assert.equal(timestampMilliseconds('1704067200', 'milliseconds'), 1704067200);
  assert.equal(timestampMilliseconds(' 000123 ', 'milliseconds'), 123);
  assert.equal(timestampMilliseconds('-1', 'milliseconds'), -1);
  assert.equal(timestampMilliseconds('-1', 'seconds'), -1000);
  assert.throws(() => timestampMilliseconds('0', 'auto'));
});

test('timestamp rejects partial, fractional, exponent, unsafe and empty inputs', () => {
  for (const value of ['', ' ', '.', '1.1', '1e3', '+1', '--1', '123x', 'Infinity', '9007199254740993']) {
    assert.throws(() => timestampMilliseconds(value, 'milliseconds'));
    assert.throws(() => timestampMilliseconds(value, 'seconds'));
  }
});

test('date range matches the C core year 0000–9999 on both boundaries', () => {
  const earliest = -62167219200000;
  const latest = 253402300799999;
  assert.equal(timestampMilliseconds(String(earliest), 'milliseconds'), earliest);
  assert.equal(timestampMilliseconds(String(latest), 'milliseconds'), latest);
  assert.equal(new Date(earliest).toISOString(), '0000-01-01T00:00:00.000Z');
  assert.equal(new Date(latest).toISOString(), '9999-12-31T23:59:59.999Z');
  assert.throws(() => timestampMilliseconds(String(earliest - 1), 'milliseconds'));
  assert.throws(() => timestampMilliseconds(String(latest + 1), 'milliseconds'));
  assert.throws(() => timestampMilliseconds('253402300800', 'seconds'));
});

test('Unix seconds retain exact decimal milliseconds including pre-epoch dates', () => {
  for (const [input, expected] of [[0, '0'], [1, '0.001'], [-1, '-0.001'], [-1010, '-1.01'],
    [1704067200123, '1704067200.123'], [253402300799999, '253402300799.999'], [-62167219199999, '-62167219199.999']]) {
    assert.equal(unixSecondsText(input), expected);
  }
});

test('local date rendering names its numeric offset and preserves milliseconds', () => {
  const value = localDateText(1704067200123);
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.123 UTC[+-]\d{2}:\d{2}$/);
  const nativeOffset = new Date(1704067200123).getTimezoneOffset();
  assert.equal(value.includes('UTC+'), nativeOffset <= 0);
});

test('all representative millisecond timestamps round-trip through decimal seconds text', () => {
  for (let sample = -999999; sample <= 999999; sample += 997) {
    assert.equal(Math.round(Number(unixSecondsText(sample)) * 1000), sample);
  }
});
