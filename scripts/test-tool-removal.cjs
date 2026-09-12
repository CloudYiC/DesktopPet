#!/usr/bin/env node
'use strict';

// Build web WASM first: npm --prefix web run build:wasm.
// This prevents removed entries from surviving in catalogs or native exports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));

function loadTypeScript(relativePath) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

test('desktop catalog removes number formatting and names the database workbench', () => {
  const catalog = loadTypeScript('frontend/src/toolbox/catalog.ts');
  assert.equal(catalog.TOOL_DEFINITIONS.some((tool) => tool.id === 'numfmt'), false);
  assert.equal(catalog.TOOL_DEFINITIONS.find((tool) => tool.id === 'database-studio').name, '数据库工作台');
  assert.ok(catalog.TOOL_DEFINITIONS.some((tool) => tool.id === 'timestamp'));
  assert.equal(catalog.READY_TOOL_COUNT, catalog.TOOL_DEFINITIONS.length);
});

test('web removes the formatter from the catalog, slug lookup, and runners', () => {
  const catalog = loadTypeScript('web/lib/catalog.ts');
  const runners = loadTypeScript('web/lib/runnableTools.ts');
  assert.equal(catalog.TOOLS.some((tool) => tool.id === 'numfmt'), false);
  assert.equal(catalog.getToolBySlug('numfmt'), undefined);
  assert.equal(runners.isRunnableTool('numfmt'), false);
  assert.equal(runners.isWasmNativeTool('numfmt'), false);
  assert.equal(runners.isRunnableTool('timestamp'), true);
});

test('rebuilt WASM drops number-format exports without changing timestamp conversion', async () => {
  const bytes = fs.readFileSync(path.join(root, 'web/public/wasm/cloudyic-native.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;
  assert.equal(exports.cy_number_group, undefined);
  assert.equal(exports.cy_web_number_group, undefined);
  for (const name of ['cy_web_uuid_v4', 'cy_web_password_generate', 'cy_web_base64_encode']) {
    assert.equal(typeof exports[name], 'function', `${name} must remain available`);
  }
  const length = exports.cy_web_timestamp_to_iso(0, 0, 0);
  const output = new Uint8Array(exports.memory.buffer, exports.cy_web_output_ptr(), length);
  assert.equal(new TextDecoder().decode(output), '1970-01-01T00:00:00.000Z');
});
