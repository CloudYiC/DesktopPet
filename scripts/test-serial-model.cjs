#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const filename = path.join(root, 'frontend/src/bridge/serialBridge.ts');
const loaded = new Module(filename, module);
let unexpectedNativeCalls = 0;
loaded.require = (name) => {
  if (name === './hostBridge') return { isNativeHost: false, requestNativePayload() { unexpectedNativeCalls += 1; throw new Error('No browser native calls allowed'); } };
  return require(name);
};
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const bridge = loaded.exports;

test('serial text uses UTF-8 bytes without hidden delimiters', () => {
  const result = bridge.serialPayload('云依😀', 'text', 'none');
  assert.equal(result.count, Buffer.byteLength('云依😀'));
  assert.equal(result.hex, Buffer.from('云依😀').toString('hex'));
});
test('all four line endings are explicit, including CR-only terminals', () => {
  for (const [ending, suffix] of [['none', ''], ['cr', '\r'], ['lf', '\n'], ['crlf', '\r\n']]) {
    assert.equal(bridge.serialPayload('HELLO', 'text', ending).hex, Buffer.from('HELLO' + suffix).toString('hex'));
  }
  assert.deepEqual(bridge.serialPayload('', 'text', 'cr'), { count: 1, hex: '0d' });
});
test('HEX permits whitespace but does not append text line endings', () => {
  assert.deepEqual(bridge.serialPayload('00 ff\n80 7F\t01', 'hex', 'crlf'), { count: 5, hex: '00ff807f01' });
  for (const invalid of ['', ' ', 'f', '0xz1', '01:02', 'GG', '123']) assert.throws(() => bridge.serialPayload(invalid, 'hex', 'none'));
});
test('64 KiB boundary is measured in bytes and includes line endings', () => {
  assert.equal(bridge.serialPayload('a'.repeat(65536), 'text', 'none').count, 65536);
  assert.throws(() => bridge.serialPayload('a'.repeat(65536), 'text', 'lf'));
  assert.equal(bridge.serialPayload('00'.repeat(65536), 'hex', 'none').count, 65536);
  assert.throws(() => bridge.serialPayload('00'.repeat(65537), 'hex', 'none'));
  assert.throws(() => bridge.serialPayload('云'.repeat(21846), 'text', 'none'));
  assert.throws(() => bridge.serialPayload('', 'text', 'none'));
});
test('ordinary browser rejects COM enumerate/open/send/stop/poll rather than faking success', async () => {
  const operations = [() => bridge.enumerateSerial(), () => bridge.startSerial({ port: 'COM1' }), () => bridge.sendSerial('00'), () => bridge.stopSerial(), () => bridge.pollSerial()];
  for (const operation of operations) await assert.rejects(operation, /Windows.*COM/);
  assert.equal(unexpectedNativeCalls, 0);
});
