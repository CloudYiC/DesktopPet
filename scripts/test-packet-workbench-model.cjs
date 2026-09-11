#!/usr/bin/env node
'use strict';

/**
 * Pure model regression checks, without a browser or native desktop host.
 * Run from any directory: node scripts/test-packet-workbench-model.cjs
 * TypeScript is loaded from the frontend's existing development dependencies;
 * source modules are compiled only in memory, with no generated files.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const ts = require(path.join(projectRoot, 'frontend/node_modules/typescript'));

function loadTypeScript(relativePath) {
  const filename = path.join(projectRoot, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const model = loadTypeScript('shared/packet-inspector/workbenchModel.ts');
const parser = loadTypeScript('shared/packet-inspector/packetParser.ts');
const normalized = parser.normalizeHexInput(model.UDP_SAMPLE);
const sample = parser.inspectPacket(normalized.bytes, 'auto');

function customField(overrides = {}) {
  return {
    id: 'test-field', name: '消息类型', offset: 0, length: 1,
    type: 'uint', endian: 'big', ...overrides,
  };
}

test('UDP example contains 66 bytes with 42 header bytes and 24 unknown payload bytes', () => {
  assert.equal(normalized.bytes.length, 66);
  assert.equal(normalized.hex.length, 132);
  assert.equal(sample.byteCount, 66);
  assert.deepEqual(sample.layers.map((layer) => layer.id), ['ethernet', 'ipv4', 'udp', 'payload']);
  assert.deepEqual(sample.layers.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 14 }, { offset: 14, length: 20 },
    { offset: 34, length: 8 }, { offset: 42, length: 24 },
  ]);
  assert.equal(model.layerLabel(sample.layers[3]), '未解析载荷');
});

test('initial selection points to the actual UDP source-port bytes', () => {
  const selection = model.initialSelection(sample);
  assert.equal(selection.layer, 'udp');
  assert.deepEqual(selection.range, { offset: 34, length: 2 });
  assert.equal(model.integerValue(sample.bytes.slice(34, 36), 'big'), '24576');
  const fieldIndex = Number(selection.key.split(':')[1]);
  assert.equal(model.fieldLabel(sample.fields[fieldIndex]), '源端口');
});

test('range bounds accept the last byte and reject empty, fractional and unsafe ranges', () => {
  assert.equal(model.rangeInPacket({ offset: 65, length: 1 }, 66), true);
  assert.equal(model.rangeInPacket({ offset: 0, length: 65536 }, 65536), true);
  for (const range of [
    { offset: -1, length: 1 }, { offset: 0, length: 0 },
    { offset: 66, length: 1 }, { offset: 65, length: 2 },
    { offset: 0.5, length: 1 }, { offset: 0, length: 1.5 },
    { offset: NaN, length: 1 }, { offset: Infinity, length: 1 },
    { offset: Number.MAX_SAFE_INTEGER + 1, length: 1 },
  ]) assert.equal(model.rangeInPacket(range, 66), false);
  assert.equal(model.rangeInPacket({ offset: 0, length: 1 }, 0), false);
});

test('offset navigation distinguishes decimal from prefixed hexadecimal and rejects invalid input', () => {
  assert.equal(model.parseOffset('34', 66), 34);
  assert.equal(model.parseOffset(' 0x0022 ', 66), 34);
  assert.equal(model.parseOffset('0XFFFF', 65536), 65535);
  assert.equal(model.parseOffset('0', 1), 0);
  for (const value of ['', '22h', 'FF', '-1', '+1', '1.5', '1e1', '0x', 'NaN']) {
    assert.throws(() => model.parseOffset(value, 66), /请输入十进制偏移/);
  }
  for (const value of ['66', '0x42', '9007199254740992']) {
    assert.throws(() => model.parseOffset(value, 66), /偏移范围/);
  }
  assert.throws(() => model.parseOffset('0', 0), /请先分析报文/);
});

test('64-bit unsigned and signed integers preserve precision and honor byte order', () => {
  assert.equal(model.integerValue(Array(8).fill(255), 'big'), '18446744073709551615');
  assert.equal(model.integerValue(Array(8).fill(255), 'big', true), '-1');
  assert.equal(model.integerValue([128, 0, 0, 0, 0, 0, 0, 0], 'big', true), '-9223372036854775808');
  assert.equal(model.integerValue([0, 0, 0, 0, 0, 0, 0, 128], 'little', true), '-9223372036854775808');
  assert.equal(model.integerValue([127, 255, 255, 255, 255, 255, 255, 255], 'big', true), '9223372036854775807');
  assert.equal(model.integerValue([1, 2], 'big'), '258');
  assert.equal(model.integerValue([1, 2], 'little'), '513');
  assert.equal(model.integerValue([], 'big'), '—');
  assert.equal(model.integerValue(Array(9).fill(1), 'big'), '—');
});

test('legacy v1 Hex, unsigned integer and string templates survive a storage round trip', () => {
  assert.equal(model.CUSTOM_FIELDS_KEY, 'cloudyi.packet-inspector.custom-fields.v1');
  const templates = ['hex', 'uint', 'string'].map((type) => customField({ id: type, type }));
  assert.deepEqual(model.readCustomFields(JSON.stringify(templates)), templates);
  const legacyText = customField({ type: 'string', length: 5 });
  assert.equal(model.fieldValue(legacyText, [0xe4, 0xbe, 0x9d, 0, 65]), '依·A');
});

test('invalid persisted schema entries are ignored without losing valid entries', () => {
  const valid = customField();
  const invalid = [
    null, false, 'field', {}, customField({ offset: -1 }),
    customField({ length: 0 }), customField({ length: 9, type: 'int' }),
    customField({ offset: 65536 }), customField({ type: 'float' }),
    customField({ endian: 'middle' }), customField({ offset: 0.5 }),
  ];
  assert.deepEqual(model.readCustomFields(JSON.stringify([valid, ...invalid])), [valid]);
  for (const raw of [null, '', '{broken', '{}', 'null', '42']) {
    assert.deepEqual(model.readCustomFields(raw), []);
  }
});

test('a saved field outside a shorter packet remains available and displays an explicit boundary message', () => {
  const saved = customField({ offset: 42, length: 2 });
  const [restored] = model.readCustomFields(JSON.stringify([saved]));
  assert.deepEqual(restored, saved);
  assert.equal(model.rangeInPacket(restored, 24), false);
  assert.equal(model.fieldValue(restored, Array(24).fill(0)), '超出当前报文');
  // Correcting the range makes the same saved schema usable again.
  assert.equal(model.fieldValue({ ...restored, offset: 0 }, [1, 2]), '258');
});

test('custom Hex, ASCII, UTF-8 and signed fields render their requested interpretation', () => {
  assert.equal(model.fieldValue(customField({ type: 'hex', length: 3 }), [0, 171, 255]), '00 AB FF');
  assert.equal(model.fieldValue(customField({ type: 'ascii', length: 4 }), [65, 0, 127, 255]), 'A···');
  assert.equal(model.fieldValue(customField({ type: 'utf8', length: 3 }), [0xe4, 0xbe, 0x9d]), '依');
  assert.equal(model.fieldValue(customField({ type: 'int', length: 2, endian: 'little' }), [0, 128]), '-32768');
});

test('full-size raw packets and templates retain bytes beyond the former 8 KiB display limit', () => {
  const packet = parser.normalizeHexInput('AB'.repeat(65536));
  const analysis = parser.inspectPacket(packet.bytes, 'raw');
  const field = customField({ type: 'hex', length: 65536 });
  assert.equal(analysis.bytes.length, 65536);
  assert.equal(model.parseOffset('0xFFFF', analysis.bytes.length), 65535);
  assert.deepEqual(model.readCustomFields(JSON.stringify([field])), [field]);
  assert.equal(model.fieldValue(field, analysis.bytes).length, 65536 * 3 - 1);
  assert.equal(model.fieldValue({ ...field, offset: 65535, length: 1 }, analysis.bytes), 'AB');
  assert.throws(() => parser.normalizeHexInput('AB'.repeat(65537)), /最多分析 65536 字节/);
});

test('layer matching respects field boundaries and does not assign a cross-layer range', () => {
  assert.equal(model.layerAt(sample, { offset: 34, length: 2 }).id, 'udp');
  assert.equal(model.layerAt(sample, { offset: 42, length: 24 }).id, 'payload');
  assert.equal(model.layerAt(sample, { offset: 33, length: 2 }), undefined);
  assert.equal(model.isPayload({ id: 'raw' }), true);
  assert.equal(model.isPayload({ id: 'trailing' }), true);
  assert.equal(model.isPayload({ id: 'udp' }), false);
});
