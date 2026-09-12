#!/usr/bin/env node
'use strict';

// Run with node scripts/test-image-background-model.cjs. TypeScript stays in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const ts = require(path.join(projectRoot, 'frontend/node_modules/typescript'));
const filename = path.join(projectRoot, 'frontend/src/toolbox/imageBackground.ts');
const workerFilename = path.join(projectRoot, 'frontend/src/toolbox/imageBackground.worker.ts');
const source = fs.readFileSync(filename, 'utf8');
const workerSource = fs.readFileSync(workerFilename, 'utf8');
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 };
const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { detectEdgeColor, replaceBackground } = loaded.exports;

const BLUE = { r: 20, g: 90, b: 210 };
const WHITE = { r: 255, g: 255, b: 255 };
const RED = { r: 230, g: 30, b: 20 };
const options = (changes = {}) => ({
  mode: 'replace', sourceColor: BLUE, targetColor: WHITE, tolerance: 0, feather: 0, ...changes,
});
function solid(width, height, color = BLUE, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) setPixel(data, width, pixel % width, Math.floor(pixel / width), color, alpha);
  return data;
}
function setPixel(data, width, x, y, color, alpha = 255) {
  data.set([color.r, color.g, color.b, alpha], (y * width + x) * 4);
}
const pixelAt = (data, width, x, y) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('keep returns an independent byte-identical array and never mutates the input', () => {
  const input = solid(3, 2, BLUE, 128);
  const saved = input.slice();
  const result = replaceBackground(input, 3, 2, options({ mode: 'keep' }));
  assert.deepEqual(result.data, saved);
  assert.deepEqual(input, saved);
  assert.notEqual(result.data, input);
  assert.notEqual(result.data.buffer, input.buffer);
  assert.equal(result.replacedPixels, 0);
  result.data[0] = 99;
  assert.deepEqual(input, saved);
});

test('solid background is replaced, the opaque subject is unchanged, and input is preserved', () => {
  const input = solid(7, 7);
  for (let y = 2; y <= 4; y += 1) for (let x = 2; x <= 4; x += 1) setPixel(input, 7, x, y, RED);
  const saved = input.slice();
  const result = replaceBackground(input, 7, 7, options());
  assert.equal(result.replacedPixels, 40);
  assert.deepEqual(pixelAt(result.data, 7, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.data, 7, 3, 3), [230, 30, 20, 255]);
  assert.deepEqual(input, saved);
});

test('blue clothing enclosed by a nonmatching subject is not globally replaced', () => {
  const input = solid(7, 7);
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) setPixel(input, 7, x, y, RED);
  for (let y = 2; y <= 4; y += 1) for (let x = 2; x <= 4; x += 1) setPixel(input, 7, x, y, BLUE);
  const result = replaceBackground(input, 7, 7, options({ targetColor: null }));
  assert.equal(result.replacedPixels, 24);
  assert.equal(pixelAt(result.data, 7, 0, 3)[3], 0);
  assert.deepEqual(pixelAt(result.data, 7, 3, 3), [20, 90, 210, 255]);
});

test('all boundary components seed the flood, even when separated by a subject wall', () => {
  const input = solid(5, 5);
  for (let y = 0; y < 5; y += 1) setPixel(input, 5, 2, y, RED);
  const result = replaceBackground(input, 5, 5, options());
  assert.equal(result.replacedPixels, 20);
  assert.deepEqual(pixelAt(result.data, 5, 0, 2), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.data, 5, 4, 2), [255, 255, 255, 255]);
});

test('diagonal contact alone does not cross a four-neighbour subject boundary', () => {
  const input = solid(3, 3, RED);
  setPixel(input, 3, 0, 0, BLUE);
  setPixel(input, 3, 1, 1, BLUE);
  const result = replaceBackground(input, 3, 3, options());
  assert.equal(result.replacedPixels, 1);
  assert.deepEqual(pixelAt(result.data, 3, 1, 1), [20, 90, 210, 255]);
});

test('a real matching opening makes an enclosed background area reachable', () => {
  const input = solid(5, 5, RED);
  for (let y = 0; y < 4; y += 1) setPixel(input, 5, 2, y, BLUE);
  const result = replaceBackground(input, 5, 5, options());
  assert.equal(result.replacedPixels, 4);
  assert.deepEqual(pixelAt(result.data, 5, 2, 3), [255, 255, 255, 255]);
});

test('transparent border and transparent passages ignore hidden RGB when connecting visible background', () => {
  const input = solid(5, 5, RED);
  setPixel(input, 5, 2, 0, RED, 0);
  setPixel(input, 5, 2, 1, WHITE, 0);
  setPixel(input, 5, 2, 2, BLUE);
  const result = replaceBackground(input, 5, 5, options({ targetColor: null }));
  assert.equal(result.replacedPixels, 1);
  assert.equal(pixelAt(result.data, 5, 2, 2)[3], 0);
  assert.deepEqual(pixelAt(result.data, 5, 1, 2), [230, 30, 20, 255]);
});

test('a transparent enclosed hole does not create a new flood seed', () => {
  const input = solid(5, 5, RED);
  setPixel(input, 5, 2, 2, WHITE, 0);
  setPixel(input, 5, 2, 3, BLUE);
  const result = replaceBackground(input, 5, 5, options({ targetColor: null }));
  assert.equal(result.replacedPixels, 0);
  assert.deepEqual(result.data, input);
});

test('tolerance is inclusive RGB Euclidean distance, not per-channel distance', () => {
  const input = solid(3, 1, { r: 100, g: 100, b: 100 });
  setPixel(input, 3, 1, 0, { r: 106, g: 108, b: 100 });
  setPixel(input, 3, 2, 0, { r: 110, g: 110, b: 100 });
  const result = replaceBackground(input, 3, 1, options({ sourceColor: { r: 100, g: 100, b: 100 }, tolerance: 10, targetColor: null }));
  assert.equal(result.replacedPixels, 2);
  assert.equal(pixelAt(result.data, 3, 1, 0)[3], 0);
  assert.equal(pixelAt(result.data, 3, 2, 0)[3], 255);
});

test('feather starts at full removal and smoothly reaches no removal at its outer threshold', () => {
  const input = solid(5, 1, { r: 100, g: 0, b: 0 });
  [100, 110, 120, 130, 140].forEach((r, x) => setPixel(input, 5, x, 0, { r, g: 0, b: 0 }));
  const result = replaceBackground(input, 5, 1, options({ sourceColor: { r: 100, g: 0, b: 0 }, tolerance: 10, feather: 20, targetColor: null }));
  assert.deepEqual([0, 1, 2, 3, 4].map((x) => pixelAt(result.data, 5, x, 0)[3]), [0, 0, 128, 255, 255]);
  assert.equal(result.replacedPixels, 3);
  const tiny = replaceBackground(solid(1, 1, { r: 101, g: 0, b: 0 }), 1, 1,
    options({ sourceColor: { r: 100, g: 0, b: 0 }, tolerance: 0, feather: 20, targetColor: null }));
  assert.ok(tiny.data[3] < 3, 'near-exact matches must not become almost opaque');
});

test('zero-removal pixels at the feather boundary cannot bridge a subject into enclosed blue', () => {
  const input = solid(5, 5, RED);
  setPixel(input, 5, 2, 0, BLUE);
  setPixel(input, 5, 2, 1, { ...BLUE, r: BLUE.r + 30 });
  setPixel(input, 5, 2, 2, BLUE);
  const result = replaceBackground(input, 5, 5, options({ tolerance: 10, feather: 20, targetColor: null }));
  assert.equal(result.replacedPixels, 1);
  assert.equal(pixelAt(result.data, 5, 2, 2)[3], 255);
});

test('transparent output multiplies existing alpha while preserving nonmatching semitransparency', () => {
  const input = solid(2, 1, { r: 120, g: 0, b: 0 }, 128);
  setPixel(input, 2, 1, 0, RED, 64);
  const result = replaceBackground(input, 2, 1, options({ sourceColor: { r: 100, g: 0, b: 0 }, tolerance: 10, feather: 20, targetColor: null }));
  assert.equal(result.data[3], 64);
  assert.deepEqual(pixelAt(result.data, 2, 1, 0), [230, 30, 20, 64]);
});

test('fill composites behind transparent and semitransparent pixels without recolouring opaque pixels', () => {
  const input = solid(3, 1, RED);
  setPixel(input, 3, 0, 0, BLUE, 0);
  setPixel(input, 3, 1, 0, RED, 128);
  const result = replaceBackground(input, 3, 1, options({ mode: 'fill' }));
  assert.equal(result.replacedPixels, 2);
  assert.deepEqual(pixelAt(result.data, 3, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(result.data, 3, 1, 0), [242, 142, 137, 255]);
  assert.deepEqual(pixelAt(result.data, 3, 2, 0), [230, 30, 20, 255]);
});

test('fill with no target is a no-op and replace combines mask and original alpha before compositing', () => {
  const input = solid(1, 1, { r: 120, g: 0, b: 0 }, 128);
  const noop = replaceBackground(input, 1, 1, options({ mode: 'fill', targetColor: null }));
  assert.deepEqual(noop.data, input);
  assert.equal(noop.replacedPixels, 0);
  const result = replaceBackground(input, 1, 1, options({ sourceColor: { r: 100, g: 0, b: 0 }, tolerance: 10, feather: 20 }));
  assert.deepEqual([...result.data], [221, 191, 191, 255]);
});

test('no match reports zero and returns byte-identical pixels, while same-colour replacement still counts', () => {
  const input = solid(4, 4, RED);
  const result = replaceBackground(input, 4, 4, options());
  assert.equal(result.replacedPixels, 0);
  assert.deepEqual(result.data, input);
  assert.equal(replaceBackground(solid(2, 2), 2, 2, options({ targetColor: BLUE })).replacedPixels, 4);
});

test('1x1, 1xN and Nx1 images have valid edges without duplicate processing', () => {
  for (const [width, height] of [[1, 1], [1, 12], [12, 1]]) {
    const input = solid(width, height);
    assert.deepEqual(detectEdgeColor(input, width, height), BLUE);
    assert.equal(replaceBackground(input, width, height, options()).replacedPixels, width * height);
  }
});

test('edge detection ignores image interior, transparent edge RGB and low-alpha outliers', () => {
  const input = solid(9, 9, RED);
  for (let x = 0; x < 9; x += 1) {
    setPixel(input, 9, x, 0, BLUE);
    setPixel(input, 9, x, 8, BLUE);
  }
  for (let y = 1; y < 8; y += 1) {
    setPixel(input, 9, 0, y, WHITE, 0);
    setPixel(input, 9, 8, y, RED, 1);
  }
  assert.deepEqual(detectEdgeColor(input, 9, 9), BLUE);
  assert.equal(detectEdgeColor(solid(5, 5, RED, 0), 5, 5), null);
});

test('edge colour averages mild JPEG-like variation across colour-bin boundaries', () => {
  const input = solid(8, 1);
  for (let x = 0; x < 8; x += 1) setPixel(input, 8, x, 0, { r: x % 2 ? 33 : 31, g: 95, b: 210 });
  assert.deepEqual(detectEdgeColor(input, 8, 1), { r: 32, g: 95, b: 210 });
});

test('invalid dimensions, buffers, colours and nonfinite parameters fail before large allocation', () => {
  for (const [width, height] of [[0, 1], [-1, 1], [1.5, 2], [1, 4097], [4097, 1], [NaN, 1], [Infinity, 2]]) {
    assert.throws(() => replaceBackground(new Uint8ClampedArray(4), width, height, options()));
    assert.throws(() => detectEdgeColor(new Uint8ClampedArray(4), width, height));
  }
  assert.throws(() => replaceBackground(new Uint8ClampedArray(3), 1, 1, options()));
  assert.throws(() => replaceBackground([0, 0, 0, 255], 1, 1, options()));
  for (const invalid of [{ mode: 'unknown' }, { tolerance: -1 }, { tolerance: 151 }, { tolerance: NaN },
    { feather: -1 }, { feather: 61 }, { feather: Infinity }, { sourceColor: null },
    { targetColor: { r: 256, g: 0, b: 0 } }, { sourceColor: { r: 0, g: Infinity, b: 0 } }]) {
    assert.throws(() => replaceBackground(solid(1, 1), 1, 1, options(invalid)));
  }
});

test('200 randomized colour maps agree with a simple independent flood-fill oracle', () => {
  let seed = 0x7631ef;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const width = 1 + random() % 13;
    const height = 1 + random() % 13;
    const input = solid(width, height, RED);
    const match = [];
    const expected = new Set();
    const pending = [];
    for (let p = 0; p < width * height; p += 1) {
      match[p] = (random() % 5) < 3;
      if (match[p]) setPixel(input, width, p % width, Math.floor(p / width), BLUE);
      if (match[p] && (p < width || p >= width * (height - 1) || p % width === 0 || p % width === width - 1)) pending.push(p);
    }
    while (pending.length) {
      const p = pending.pop();
      if (expected.has(p) || !match[p]) continue;
      expected.add(p);
      const x = p % width;
      if (x > 0) pending.push(p - 1);
      if (x + 1 < width) pending.push(p + 1);
      if (p >= width) pending.push(p - width);
      if (p + width < width * height) pending.push(p + width);
    }
    const result = replaceBackground(input, width, height, options({ targetColor: null }));
    assert.equal(result.replacedPixels, expected.size);
    for (let p = 0; p < width * height; p += 1) assert.equal(result.data[p * 4 + 3], expected.has(p) ? 0 : 255);
  }
});

test('worker returns transferable RGBA, preserves explicit source selection, and reports malformed requests', () => {
  const messages = [];
  const worker = { onmessage: null, postMessage: (reply, transfer) => messages.push({ reply, transfer }) };
  const workerCompiled = ts.transpileModule(workerSource, { fileName: workerFilename, compilerOptions });
  vm.runInNewContext(workerCompiled.outputText, {
    exports: {}, self: worker, Uint8ClampedArray, ArrayBuffer, Error,
    require: (name) => { assert.equal(name, './imageBackground'); return loaded.exports; },
  }, { filename: workerFilename });
  const request = { id: 7, data: solid(2, 2, RED).buffer, width: 2, height: 2, options: options() };
  worker.onmessage({ data: request });
  assert.equal(messages[0].reply.id, 7);
  assert.equal(messages[0].reply.replacedPixels, 0, 'red edge detection must not override the requested blue source');
  assert.deepEqual(messages[0].reply.detectedColor, RED);
  assert.equal(messages[0].transfer.length, 1);
  assert.equal(messages[0].transfer[0], messages[0].reply.data);
  assert.deepEqual(new Uint8ClampedArray(messages[0].reply.data), new Uint8ClampedArray(request.data));
  worker.onmessage({ data: { ...request, id: 8, width: 3 } });
  assert.equal(messages[1].reply.id, 8);
  assert.match(messages[1].reply.error, /像素数据/);
  worker.onmessage({ data: null });
  assert.equal(typeof messages[2].reply.error, 'string');
});

test('model and worker do not contain network, storage or native-bridge calls', () => {
  for (const content of [source, workerSource]) {
    assert.doesNotMatch(content, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|chrome\.webview|require)\b/u);
    assert.doesNotMatch(content, /https?:\/\//u);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network calls are forbidden'); };
  try {
    assert.equal(replaceBackground(solid(2, 2), 2, 2, options()).replacedPixels, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maximum 4096x4096 input completes with a bounded iterative queue and deterministic output', () => {
  const width = 4096;
  const height = 4096;
  const input = new Uint8ClampedArray(width * height * 4);
  // A white opaque image can be initialised efficiently with a byte fill.
  input.fill(255);
  const started = performance.now();
  const result = replaceBackground(input, width, height, options({ sourceColor: WHITE, targetColor: null, tolerance: 20, feather: 20 }));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10000, `4096-square flood took ${elapsed.toFixed(1)} ms`);
  assert.equal(result.replacedPixels, width * height);
  assert.equal(result.data.length, input.length);
  assert.equal(result.data[3], 0);
  assert.equal(result.data[result.data.length - 1], 0);
  assert.equal(input[3], 255);
  const detectionStarted = performance.now();
  assert.deepEqual(detectEdgeColor(input, width, height), WHITE);
  assert.ok(performance.now() - detectionStarted < 1000, 'edge sampling must remain bounded');
});
