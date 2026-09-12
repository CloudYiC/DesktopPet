/** Pure frontend reference-address contracts; this never accesses a device. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const file = path.join(root, 'frontend/src/bridge/modbusBridge.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = new Module(file, module);
loaded.filename = file;
loaded.require = (name) => name === './hostBridge' ? { isNativeHost: false, requestNativePayload: () => { throw new Error('unexpected real bridge'); } } : require(name);
loaded._compile(compiled, file);
const { modbusReference, modbusProtocolAddress, modbusQuantityLimit, isModbusWrite, modbusCall } = loaded.exports;
test('zero-based offsets use the right reference area for every supported function', () => {
  for (const [code, expected] of [[1,'00001'],[2,'10001'],[3,'40001'],[4,'30001'],[5,'00001'],[6,'40001'],[15,'00001'],[16,'40001']]) {
    assert.equal(modbusReference(code, 0), expected);
    assert.equal(modbusProtocolAddress(code, expected), 0);
    assert.equal(modbusProtocolAddress(code, modbusReference(code, 9998)), 9998);
  }
});
test('reference input never silently reinterprets another register area', () => {
  assert.throws(() => modbusProtocolAddress(3, '30001'));
  assert.throws(() => modbusProtocolAddress(3, '40000'));
  assert.throws(() => modbusProtocolAddress(1, '1'));
  assert.throws(() => modbusProtocolAddress(3, '465536'));
  assert.match(modbusReference(3, 65535), /超出/);
});
test('Modbus function-specific limits and write classification are explicit', () => {
  assert.deepEqual([1,2,3,4,5,6,15,16].map(modbusQuantityLimit), [2000,2000,125,125,1,1,1968,123]);
  assert.deepEqual([1,2,3,4,5,6,15,16].map(isModbusWrite), [false,false,false,false,true,true,true,true]);
});
test('browser refuses device operations rather than fabricating success', async () => {
  await assert.rejects(modbusCall('start', { host: '127.0.0.1' }), /仅在 Windows/);
});
