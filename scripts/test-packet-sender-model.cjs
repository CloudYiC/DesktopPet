#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const filename = path.join(root, 'frontend/src/toolbox/packetSenderModel.ts');
const loaded = new Module(filename, module);
loaded.require = () => { throw new Error('Packet sender model must have no I/O dependencies'); };
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const model = loaded.exports;
const draft = (overrides = {}) => ({ ...model.createDefaultPacketDraft(), ...(overrides.protocol ? { networkMode: overrides.protocol === 'tcp' ? 'tcp-client' : 'udp' } : {}), ...overrides });
const saved = (id, overrides = {}) => ({ ...draft(overrides), id, updatedAt: '2026-09-14T08:00:00.000Z' });
const library = (...packets) => ({ schemaVersion: 1, packets });

test('default draft is editable with automatic adapter selection, local target and no running state', () => {
  const value = model.createDefaultPacketDraft();
  assert.equal(value.protocol, 'udp');
  assert.equal(value.networkMode, 'udp');
  assert.equal(value.lineEnding, 'none');
  assert.equal(value.host, '127.0.0.1');
  assert.equal(value.port, 9000);
  assert.equal(value.localAddress, '0.0.0.0');
  assert.equal(value.multicastTtl, 1);
  assert.equal(value.localPort, 0);
  assert.equal(value.intervalMs, 1000);
  assert.equal(value.repeatCount, 1);
  assert.deepEqual(model.validatePacketDraft(value), value);
  assert.equal(model.PACKET_LIBRARY_STORAGE_KEY, 'cloudyi.packet-sender.library.v1');
  assert.equal(model.encodePacketPayload(draft({ payload: '' })).byteCount, 0);
  assert.notEqual(model.createDefaultPacketDraft(), value);
});

test('legacy schema-1 drafts retain every original field and infer only optional defaults in memory', () => {
  for (const protocol of ['tcp', 'udp']) {
    const old = saved('old-loopback', { protocol, localAddress: '127.0.0.1', host: '224.20.20.20', port: 24576, dataMode: 'hex', payload: '00 FF 80 0D 0a' });
    delete old.multicastTtl;
    delete old.networkMode;
    delete old.lineEnding;
    const original = JSON.stringify(library(old));
    const restored = model.parsePacketLibrary(original).packets[0];
    assert.deepEqual(restored, { ...old, multicastTtl: 1, networkMode: protocol === 'tcp' ? 'tcp-client' : 'udp', lineEnding: 'none' });
    assert.equal(model.packetNetworkMode(old), protocol === 'tcp' ? 'tcp-client' : 'udp');
    assert.equal(model.encodeNetworkPayload(old).hex, '00ff800d0a');
    assert.equal(JSON.stringify(library(old)), original, 'reading a legacy library never mutates the supplied data');
    assert.equal(model.parsePacketLibrary(model.serializePacketLibrary(library(restored))).packets[0].payload, old.payload);
  }
  for (const multicastTtl of [-1, 256, 1.5, '1', null]) assert.throws(() => model.validatePacketDraft(draft({ multicastTtl })));
  for (const multicastTtl of [0, 1, 255]) assert.equal(model.validatePacketDraft(draft({ multicastTtl })).multicastTtl, multicastTtl);
  assert.throws(() => model.validatePacketDraft(draft({ multicastJoined: true })), /字段/);
});

test('text is UTF-8, byte count is real, no hidden terminator and no surrogate replacement', () => {
  const result = model.encodePacketPayload(draft({ payload: '云依😀\r\n' }));
  assert.equal(result.hex, Buffer.from('云依😀\r\n').toString('hex'));
  assert.equal(result.byteCount, Buffer.byteLength('云依😀\r\n'));
  assert.equal(result.text, '云依😀\r\n');
  for (const payload of ['\ud800', '\udc00', 'A\ud800B']) {
    assert.throws(() => model.encodePacketPayload(draft({ payload })), /Unicode/);
    assert.throws(() => model.encodePacketPayload(draft({ payload, dataMode: 'escaped' })), /Unicode/);
  }
});

test('HEX is strict byte pairs; whitespace and case work without forgiving invalid bytes', () => {
  assert.equal(model.encodePacketPayload(draft({ dataMode: 'hex', payload: '00 FF\n80 7f\t01' })).hex, '00ff807f01');
  for (const payload of ['f', '001', '0x01', '01:02', 'GG', '01/02']) assert.throws(() => model.encodePacketPayload(draft({ dataMode: 'hex', payload })));
  assert.equal(model.encodePacketPayload(draft({ dataMode: 'hex', payload: '\n  ' })).byteCount, 0);
});

test('Packet Sender-style escaped bytes support binary and explicit common escapes', () => {
  const result = model.encodePacketPayload(draft({ dataMode: 'escaped', payload: String.raw`A\00\ff\r\n\t\\云` }));
  assert.equal(result.hex, '4100ff0d0a095c' + Buffer.from('云').toString('hex'));
  assert.equal(result.text, null);
  assert.equal(model.encodePacketPayload(draft({ dataMode: 'escaped', payload: '\\AaF' })).hex, 'aa46');
  for (const payload of ['\\', '\\f', '\\x00', '\\q', '\\0g', '\\u1234']) assert.throws(() => model.encodePacketPayload(draft({ dataMode: 'escaped', payload })));
});

test('all 256 binary values round-trip through HEX/escaped without replacement', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const original = draft({ dataMode: 'hex', payload: all.toString('hex') });
  const escaped = model.convertPacketPayloadMode(original, 'escaped');
  assert.equal(model.encodePacketPayload(draft({ dataMode: 'escaped', payload: escaped })).hex, all.toString('hex'));
  assert.throws(() => model.convertPacketPayloadMode(original, 'text'), /UTF-8/);
  assert.equal(original.payload, all.toString('hex'));
  assert.equal(model.convertPacketPayloadMode(draft({ dataMode: 'hex', payload: '00 ff' }), 'hex'), '00 ff');
});

test('strict UTF-8 preserves BOM, null and literal replacement character when actually encoded', () => {
  for (const text of ['\ufeff云依', '\0a\0', '�', '😀']) {
    const encoded = model.encodePacketPayload(draft({ payload: text }));
    const decoded = model.convertPacketPayloadMode(draft({ dataMode: 'hex', payload: encoded.hex }), 'text');
    assert.equal(decoded, text);
    assert.equal(Buffer.from(decoded).toString('hex'), encoded.hex);
  }
  for (const hex of ['ff', 'c080', 'e08080', 'eda080', 'f4908080', 'e4b8']) assert.throws(() => model.convertPacketPayloadMode(draft({ dataMode: 'hex', payload: hex }), 'text'));
});

test('UDP and TCP payload byte boundaries are exact, including multibyte text', () => {
  for (const [protocol, limit] of [['udp', 65507], ['tcp', 65536]]) {
    assert.equal(model.encodePacketPayload(draft({ protocol, dataMode: 'hex', payload: '00'.repeat(limit) })).byteCount, limit);
    assert.throws(() => model.encodePacketPayload(draft({ protocol, payload: 'a'.repeat(limit + 1) })));
    assert.throws(() => model.encodePacketPayload(draft({ protocol, dataMode: 'escaped', payload: '\\00'.repeat(limit + 1) })));
    assert.throws(() => model.encodePacketPayload(draft({ protocol, payload: '云'.repeat(Math.floor(limit / 3) + 1) })));
  }
});

test('network payload line endings are explicit transmitted bytes for text, HEX and escaped bodies', () => {
  for (const [dataMode, payload] of [['text', '云'], ['hex', 'e4 ba 91'], ['escaped', String.raw`\e4\ba\91`]]) {
    for (const [lineEnding, suffix] of [['none', ''], ['lf', '0a'], ['crlf', '0d0a']]) {
      const value = draft({ dataMode, payload, lineEnding });
      const result = model.encodeNetworkPayload(value);
      assert.equal(result.hex, 'e4ba91' + suffix);
      assert.equal(result.byteCount, 3 + suffix.length / 2);
      assert.equal(model.encodePacketPayload(value).hex, 'e4ba91', 'raw encoder never appends terminators');
    }
  }
  assert.equal(model.encodeNetworkPayload(draft({ payload: '', lineEnding: 'lf' })).hex, '0a');
  assert.equal(model.encodeNetworkPayload(draft({ payload: 'A\r\n', lineEnding: 'crlf' })).hex, '410d0a0d0a', 'explicit body bytes are never deduplicated');
});

test('mode conversion does not bake or duplicate a selected line ending', () => {
  let value = draft({ payload: '云依\0😀', lineEnding: 'crlf' });
  const expected = Buffer.from(value.payload).toString('hex') + '0d0a';
  for (const dataMode of ['hex', 'escaped', 'text', 'hex', 'text']) {
    const payload = model.convertPacketPayloadMode(value, dataMode);
    value = { ...value, payload, dataMode };
    assert.equal(model.encodeNetworkPayload(value).hex, expected);
    assert.equal(model.encodePacketPayload(value).byteCount + 2, model.encodeNetworkPayload(value).byteCount);
  }
  assert.equal(value.payload, '云依\0😀');
});

test('UDP and TCP final-byte capacity includes selected LF and CRLF during validation and import', () => {
  for (const [protocol, limit] of [['udp', 65507], ['tcp', 65536]]) {
    for (const [lineEnding, extra] of [['none', 0], ['lf', 1], ['crlf', 2]]) {
      const exact = draft({ protocol, payload: 'a'.repeat(limit - extra), lineEnding });
      assert.equal(model.encodeNetworkPayload(exact).byteCount, limit);
      assert.equal(model.validatePacketDraft(exact).payload, exact.payload);
      const tooLarge = { ...exact, payload: exact.payload + 'a' };
      assert.throws(() => model.encodeNetworkPayload(tooLarge), /不能超过/);
      assert.throws(() => model.validatePacketDraft(tooLarge), /不能超过/);
      assert.throws(() => model.parsePacketLibrary(JSON.stringify(library(saved('too-large', tooLarge)))), /不能超过/);
    }
  }
});

test('TCP server templates round-trip as configuration without client or peer runtime state', () => {
  const server = saved('tcp-server', { protocol: 'tcp', networkMode: 'tcp-server', lineEnding: 'lf', localAddress: '127.0.0.1', localPort: 9020, intervalMs: 50, payload: 'READY' });
  const restored = model.parsePacketLibrary(model.serializePacketLibrary(library(server))).packets[0];
  assert.deepEqual(restored, server);
  assert.equal(model.packetNetworkMode(restored), 'tcp-server');
  assert.equal(model.encodeNetworkPayload(restored).hex, '52454144590a');
  for (const networkMode of ['tcp-client', 'tcp-server']) assert.equal(model.validatePacketDraft(draft({ protocol: 'tcp', networkMode })).networkMode, networkMode);
  for (const fields of [{ networkMode: 'tcp-client' }, { networkMode: 'tcp-server' }, { protocol: 'tcp', networkMode: 'udp' }, { networkMode: 'server' }, { networkMode: null }, { networkMode: true }, { lineEnding: '\n' }, { lineEnding: 'LF' }, { lineEnding: '' }, { lineEnding: null }, { lineEnding: false }]) {
    assert.throws(() => model.validatePacketDraft(draft(fields)));
    assert.throws(() => model.parsePacketLibrary(JSON.stringify(library(saved('invalid-enum', fields)))));
  }
  for (const networkMode of ['server', '', null, 0]) assert.throws(() => model.packetNetworkMode({ protocol: 'tcp', networkMode }));
  for (const lineEnding of ['invalid', '\n', null, 0]) assert.throws(() => model.encodeNetworkPayload(draft({ lineEnding })));
  const { id, updatedAt, ...serverDraft } = server;
  for (const field of ['running', 'joined', 'multicastJoined', 'peer', 'peerId', 'peers', 'sessionId', 'connected', 'autoSend']) {
    assert.throws(() => model.validatePacketDraft({ ...serverDraft, [field]: true }), /字段/);
    assert.throws(() => model.parsePacketLibrary(JSON.stringify(library({ ...server, [field]: true }))), /字段/);
  }
});

test('server mode preserves inactive endpoint edits without blocking local listening templates', () => {
  for (const [host, port] of [['', 0], ['unfinished target:', 0], ['https://not-used.invalid/path', 443], ['  draft target  ', 65535]]) {
    const value = saved('server-inactive-target', { protocol: 'tcp', networkMode: 'tcp-server', host, port, localAddress: '127.0.0.1', localPort: 9000 });
    const restored = model.parsePacketLibrary(model.serializePacketLibrary(library(value))).packets[0];
    assert.deepEqual(restored, value, 'inactive values must not be replaced with guessed targets');
    const { id, updatedAt, ...editable } = value;
    assert.throws(() => model.validatePacketDraft({ ...editable, networkMode: 'tcp-client' }), /目标/);
    assert.throws(() => model.validatePacketDraft({ ...editable, protocol: 'udp', networkMode: 'udp' }), /目标/);
  }
  for (const fields of [{ host: null }, { host: 123 }, { host: 'x'.repeat(254) }, { port: -1 }, { port: 65536 }, { port: 1.5 }, { port: '0' }]) {
    assert.throws(() => model.validatePacketDraft(draft({ protocol: 'tcp', networkMode: 'tcp-server', ...fields })));
  }
});

test('addresses allow IPv4/DNS only, identify multicast and reject unsafe or ambiguous strings', () => {
  for (const host of ['127.0.0.1', '224.20.20.20', '255.255.255.255', 'example.com', 'localhost', 'dev-1.local.', 'A.EXAMPLE']) assert.equal(model.validatePacketDraft(draft({ host })).host, host);
  assert.equal(model.isMulticastHost('224.0.0.0'), true);
  assert.equal(model.isMulticastHost('239.255.255.255'), true);
  for (const host of ['223.255.255.255', '240.0.0.0', '224.999.1.1', 'example.com']) assert.equal(model.isMulticastHost(host), false);
  for (const host of ['', 'https://example.com', 'host:9000', '::1', '[::1]', 'foo/bar', 'x;calc', 'foo bar', 'foo\nbar', '256.1.1.1', '127.1', '2130706433', '01.2.3.4', '-foo.local', 'foo_.local', 'foo..com', '.foo', 'a'.repeat(64) + '.com']) assert.throws(() => model.validatePacketDraft(draft({ host })));
  for (const localAddress of ['localhost', '', '::1', '256.0.0.1']) assert.throws(() => model.validatePacketDraft(draft({ localAddress })));
  assert.equal(model.validatePacketDraft(draft({ localAddress: '0.0.0.0' })).localAddress, '0.0.0.0');
});

test('integer limits, draft enums, all fields and absence of running state are validated', () => {
  for (const fields of [{ port: 0 }, { port: 65536 }, { port: '9000' }, { localPort: -1 }, { intervalMs: 49 }, { intervalMs: 50.5 }, { intervalMs: Infinity }, { intervalMs: 86400001 }, { repeatCount: 0 }, { repeatCount: 1001 }, { repeatCount: 1.5 }, { protocol: 'http' }, { dataMode: 'ascii' }, { name: 'bad\nname' }, { name: 'a'.repeat(81) }, { payload: 10 }, { running: true }]) assert.throws(() => model.validatePacketDraft(draft(fields)));
  assert.equal(model.validatePacketDraft(draft({ repeatCount: 1000, intervalMs: 50 })).repeatCount, 1000);
  for (const intervalMs of [50, 99, 100, 86400000]) assert.equal(model.validatePacketDraft(draft({ intervalMs })).intervalMs, intervalMs);
  const missing = draft(); delete missing.host;
  assert.throws(() => model.validatePacketDraft(missing));
});

test('pure schema-1 library imports/exports clones with exact fields and valid timestamp', () => {
  const source = library(saved('packet-1', { dataMode: 'hex', payload: '00 ff 80' }));
  const text = model.serializePacketLibrary(source);
  const result = model.parsePacketLibrary(text);
  assert.deepEqual(result, source);
  assert.notEqual(result.packets[0], source.packets[0]);
  assert.deepEqual(model.parsePacketLibrary(model.serializePacketLibrary(library())), library());
  for (const value of ['oops', '{}', '[]', 'null', JSON.stringify({ ...source, schemaVersion: 2 }), JSON.stringify({ ...source, running: true }), JSON.stringify(library({ ...source.packets[0], autoSend: true })), JSON.stringify(library({ ...source.packets[0], updatedAt: '2026-02-30T08:00:00.000Z' })), JSON.stringify(library({ ...source.packets[0], id: '../evil' })), '{"schemaVersion":1,"packets":[],"__proto__":{"polluted":true}}']) assert.throws(() => model.parsePacketLibrary(value));
  assert.equal({}.polluted, undefined);
});

test('duplicate IDs reject atomically within imports and against existing packets', () => {
  const current = library(saved('same'));
  const before = JSON.stringify(current);
  assert.throws(() => model.parsePacketLibrary(JSON.stringify(library(saved('same'), saved('same')))), /重复/);
  assert.throws(() => model.mergePacketLibraries(current, library(saved('same', { payload: 'changed' }))), /重复/);
  assert.equal(JSON.stringify(current), before);
  const merged = model.mergePacketLibraries(current, library(saved('another')));
  assert.equal(merged.packets.length, 2);
  assert.equal(current.packets.length, 1);
  assert.notEqual(merged.packets[0], current.packets[0]);
});

test('library limits cap entries and actual UTF-8 JSON size at one MiB', () => {
  assert.equal(model.parsePacketLibrary(model.serializePacketLibrary(library(...Array.from({ length: 100 }, (_, index) => saved(`p-${index}`))))).packets.length, 100);
  assert.throws(() => model.serializePacketLibrary(library(...Array.from({ length: 101 }, (_, index) => saved(`p-${index}`)))));
  assert.throws(() => model.parsePacketLibrary(' '.repeat(model.MAX_PACKET_LIBRARY_BYTES + 1)));
  assert.throws(() => model.parsePacketLibrary('云'.repeat(Math.floor(model.MAX_PACKET_LIBRARY_BYTES / 3) + 1)));
  const huge = library(...Array.from({ length: 20 }, (_, index) => saved(`p-${index}`, { payload: 'x'.repeat(60000) })));
  assert.throws(() => model.serializePacketLibrary(huge), /1 MiB/);
  assert.throws(() => model.mergePacketLibraries(library(...huge.packets.slice(0, 10)), library(...huge.packets.slice(10))), /1 MiB/);
});
