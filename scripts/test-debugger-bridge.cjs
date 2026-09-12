/** Desktop capability bridge regression; synthetic messages only, no device IO. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'frontend/src/bridge/hostBridge.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function hostFixture(native = true) {
  const listeners = new Set();
  const sent = [];
  const output = {};
  const window = { setTimeout, clearTimeout };
  if (native) window.chrome = { webview: {
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
    postMessage: (message) => sent.push(message),
  } };
  vm.runInNewContext(compiled, { exports: output, window, TextEncoder, TextDecoder },
    { filename: 'hostBridge.test.js' });
  return {
    api: output, sent,
    reply(message) { listeners.forEach((listener) => listener({ data: message })); },
  };
}

for (const prefix of ['serial', 'mqtt', 'modbus', 'network']) {
  test(`${prefix}: matched native result settles its request`, async () => {
    const fixture = hostFixture();
    const request = fixture.api.requestNativePayload(`${prefix}.poll`, {});
    const requestId = fixture.sent[0].payload.requestId;
    fixture.reply({ type: `${prefix}.poll.result`, payload: { requestId, snapshot: { state: 'stopped' }, events: [] } });
    const result = await request;
    assert.equal(result.snapshot.state, 'stopped');
    assert.equal(result.events.length, 0);
  });
  test(`${prefix}: native error is not displayed as success`, async () => {
    const fixture = hostFixture();
    const request = fixture.api.requestNativePayload(`${prefix}.start`, {});
    const requestId = fixture.sent[0].payload.requestId;
    fixture.reply({ type: `${prefix}.start.error`, payload: { requestId, message: '合成测试：连接失败' } });
    await assert.rejects(request, /连接失败/);
  });
}

test('payload cannot replace the bridge-generated request identifier', async () => {
  const fixture = hostFixture();
  const request = fixture.api.requestNativePayload('serial.poll', { requestId: 'forged' });
  const requestId = fixture.sent[0].payload.requestId;
  assert.notEqual(requestId, 'forged');
  fixture.reply({ type: 'serial.poll.result', payload: { requestId } });
  await request;
});

test('interleaved tools receive their own response with no cross-talk', async () => {
  const fixture = hostFixture();
  const requests = Array.from({ length: 60 }, (_, index) => {
    const prefix = ['serial', 'mqtt', 'modbus'][index % 3];
    return fixture.api.requestNativePayload(`${prefix}.poll`, {});
  });
  const ids = fixture.sent.map((message) => message.payload.requestId);
  assert.equal(new Set(ids).size, 60);
  for (let index = 59; index >= 0; index -= 1) fixture.reply({
    type: `${fixture.sent[index].type}.result`, payload: { requestId: ids[index], index },
  });
  const results = await Promise.all(requests);
  assert.deepEqual(results.map((value) => value.index), Array.from({ length: 60 }, (_, index) => index));
});

test('timed-out request rejects and ignores late results', async () => {
  const fixture = hostFixture();
  const request = fixture.api.requestNativePayload('mqtt.poll', {}, 10);
  await assert.rejects(request, /超时/);
  fixture.reply({ type: 'mqtt.poll.result', payload: { requestId: fixture.sent[0].payload.requestId } });
});

test('browser preview fails immediately rather than faking device success', async () => {
  const fixture = hostFixture(false);
  assert.equal(fixture.api.isNativeHost, false);
  await assert.rejects(fixture.api.requestNativePayload('modbus.start', {}), /客户端/);
  assert.equal(fixture.sent.length, 0);
});

test('software scan preserves native evidence and partial-scan warnings', async () => {
  const fixture = hostFixture();
  const request = fixture.api.requestSoftwareResidualScan({ id: 'fixture', displayName: 'Fixture App' });
  const message = fixture.sent[0];
  assert.equal(message.type, 'software.scan');
  assert.equal(message.payload.softwareId, 'fixture');
  const plan = { token: 'a'.repeat(32), scanTruncated: true, scanWarnings: ['扫描已达到限制'], residuals: [{ path: 'C:\\Fixture\\Entry.lnk', targetPath: 'C:\\Fixture\\App.exe' }] };
  fixture.reply({ type: 'software.scan.result', payload: { requestId: message.payload.requestId, plan } });
  assert.equal((await request).residuals[0].targetPath, plan.residuals[0].targetPath);
});

test('software refresh sends only plan token and accepts a revalidated new plan', async () => {
  const fixture = hostFixture();
  const request = fixture.api.requestSoftwareResidualRefresh({ token: 'a'.repeat(32), residuals: [{ path: 'untrusted' }] });
  const message = fixture.sent[0];
  assert.equal(message.type, 'software.refresh');
  assert.deepEqual(Object.keys(message.payload).sort(), ['planToken', 'requestId']);
  fixture.reply({ type: 'software.refresh.result', payload: { requestId: message.payload.requestId, plan: { token: 'b'.repeat(32), residuals: [] } } });
  assert.equal((await request).token, 'b'.repeat(32));
});

test('software cancellation and a late scan result cannot settle one another', async () => {
  const fixture = hostFixture();
  const scan = fixture.api.requestSoftwareResidualScan({ id: 'fixture', displayName: 'Fixture' });
  const cancel = fixture.api.requestSoftwareScanCancel();
  const [scanMessage, cancelMessage] = fixture.sent;
  assert.notEqual(scanMessage.payload.requestId, cancelMessage.payload.requestId);
  fixture.reply({ type: 'software.scan.error', payload: { requestId: scanMessage.payload.requestId, message: '扫描已取消。' } });
  await assert.rejects(scan, /取消/);
  fixture.reply({ type: 'software.scan.cancel.result', payload: { requestId: cancelMessage.payload.requestId } });
  await cancel;
  fixture.reply({ type: 'software.scan.result', payload: { requestId: scanMessage.payload.requestId, plan: { token: 'stale' } } });
});

test('software reveal forwards the exact plan path and surfaces native rejection', async () => {
  const fixture = hostFixture();
  const filePath = 'C:\\Fixture\\Unicode 路径\\Entry.lnk';
  const request = fixture.api.requestSoftwareReveal('a'.repeat(32), filePath);
  const message = fixture.sent[0];
  assert.equal(message.type, 'software.reveal');
  assert.equal(message.payload.path, filePath);
  fixture.reply({ type: 'software.reveal.error', payload: { requestId: message.payload.requestId, message: '计划已过期' } });
  await assert.rejects(request, /过期/);
});

test('software mutation actions cannot run in browser preview', async () => {
  const fixture = hostFixture(false);
  await fixture.api.requestSoftwareScanCancel();
  await assert.rejects(fixture.api.requestSoftwareReveal('token', 'C:\\Fixture'), /浏览器/);
  await assert.rejects(fixture.api.requestSoftwareUninstall({ id: 'fixture' }), /浏览器/);
  await assert.rejects(fixture.api.requestSoftwareCleanup({ token: 'token' }, [], 'Fixture'), /浏览器/);
  assert.equal(fixture.sent.length, 0);
});
