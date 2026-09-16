#!/usr/bin/env node
'use strict';

// Public Web scope regression: node scripts/test-web-release-scope.cjs [--built] [--ui]
// --built also inspects a freshly exported web/out directory. No network requests.
// --ui serves the export on loopback and captures isolated headless-browser previews.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'web/node_modules/typescript'));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modules = new Map();

function loadTypeScript(file) {
  const filename = path.resolve(root, file);
  if (modules.has(filename)) return modules.get(filename).exports;
  const loaded = new Module(filename, module);
  modules.set(filename, loaded);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    const source = path.resolve(path.dirname(filename), specifier + '.ts');
    return specifier.startsWith('.') && fs.existsSync(source)
      ? loadTypeScript(source) : originalRequire(specifier);
  };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const catalog = loadTypeScript('web/lib/catalog.ts');
const runners = loadTypeScript('web/lib/runnableTools.ts');

test('public changelog has no historical or newly added entries', () => {
  assert.deepEqual(catalog.CHANGELOG, []);
  assert.match(read('web/app/changelog/page.tsx'), /CHANGELOG\.length === 0/);
  assert.match(read('web/app/changelog/page.tsx'), /暂无更新日志/);
  assert.match(read('web/app/desktop/page.tsx'), /recentLog\.length > 0 &&/);
});

test('Web catalog, categories, and runnable tools exclude packet inspection', () => {
  assert.equal(catalog.getToolBySlug('packet-inspector'), undefined);
  assert.equal(runners.isRunnableTool('packet-inspector'), false);
  assert.equal(catalog.TOOLS.length, 11);
  assert.equal(catalog.categoryCounts().find((item) => item.id === 'all').count, 11);
  assert.equal(catalog.categoryCounts().some((item) => item.id === 'network'), false);
  assert.deepEqual(catalog.TOOLS.map((item) => item.id).sort(), [...runners.RUNNABLE_TOOL_IDS].sort());
});

test('direct Web routes and client dispatch cannot render the removed workbench', () => {
  const page = read('web/app/tools/[slug]/page.tsx');
  assert.match(page, /return TOOLS\.map\(/);
  assert.match(page, /if \(!tool\) notFound\(\)/);
  for (const file of ['web/app/tools/[slug]/page.tsx', 'web/app/tools/[slug]/ToolRunner.tsx']) {
    assert.doesNotMatch(read(file), /packet-inspector|PacketInspector|packetInspector/);
  }
  assert.equal(fs.existsSync(path.join(root, 'web/app/tools/[slug]/PacketInspector.tsx')), false);
  assert.equal(fs.existsSync(path.join(root, 'web/lib/packetInspector.ts')), false);
  assert.doesNotMatch(read('web/scripts/build-wasm.mjs'), /packet[_-]inspector/);
  const index = read('web/components/ToolIndex/ToolIndex.tsx');
  assert.match(index, /const byId = new Map\(tools\.map/);
  assert.match(index, /\.map\(\(id\) => byId\.get\(id\)\)/);
});

test('desktop packet inspection and shared byte workbench remain present', () => {
  assert.match(read('frontend/src/toolbox/catalog.ts'), /id: 'packet-inspector'/);
  assert.match(read('frontend/src/toolbox/Toolbox.tsx'), /activeTool\.id === 'packet-inspector'/);
  assert.match(read('frontend/src/toolbox/PacketInspector.tsx'), /PacketWorkbench/);
  assert.ok(fs.existsSync(path.join(root, 'shared/packet-inspector/PacketWorkbench.tsx')));
  assert.ok(fs.existsSync(path.join(root, 'shared/packet-inspector/packetParser.ts')));
});

test('sitemap has no packet-inspector URL or invented date for an empty changelog', () => {
  const routes = loadTypeScript('web/app/sitemap.ts').default();
  assert.equal(routes.some((item) => item.url.includes('packet-inspector')), false);
  const changelog = routes.find((item) => item.url.endsWith('/changelog/'));
  assert.ok(changelog);
  assert.equal(changelog.lastModified, undefined);
});

test('static export has no removed route, stale references, or public release entries', {
  skip: !process.argv.includes('--built'),
}, () => {
  const output = path.join(root, 'web/out');
  assert.ok(fs.existsSync(path.join(output, 'index.html')), 'Run npm --prefix web run build first');
  assert.equal(fs.existsSync(path.join(output, 'tools/packet-inspector')), false);
  const changelog = fs.readFileSync(path.join(output, 'changelog/index.html'), 'utf8');
  assert.match(changelog, /暂无更新日志/);
  assert.doesNotMatch(changelog, /v0\.[0-9]|v1\.0\.0|plugin-store change|Every release, every change/);
  const desktop = fs.readFileSync(path.join(output, 'desktop/index.html'), 'utf8');
  assert.doesNotMatch(desktop, /What is new/);
  for (const entry of fs.readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(html|js|xml|txt)$/.test(entry.name)) continue;
    const filename = path.join(entry.parentPath || entry.path, entry.name);
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /packet-inspector|PacketInspector|inspectPacket/,
      path.relative(output, filename));
  }
});

test('browser shows empty logs, eleven tools, and the verified offline download link', {
  skip: !process.argv.includes('--ui'),
}, async () => {
  const http = require('node:http');
  const { chromium } = require('playwright');
  const output = path.join(root, 'web/out');
  const screenshots = path.join(root, 'artifacts/web-release-v1');
  fs.mkdirSync(screenshots, { recursive: true });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
  const server = http.createServer((request, response) => {
    let filename;
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      filename = path.resolve(output, '.' + pathname);
      if (filename !== output && !filename.startsWith(output + path.sep)) throw new Error('Invalid path');
      if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) filename = path.join(filename, 'index.html');
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        response.statusCode = 404;
        filename = path.join(output, '404.html');
      }
    } catch {
      response.writeHead(400).end();
      return;
    }
    response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    await context.route('**/*', (route) => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await context.addInitScript(() => localStorage.setItem('cy.web.recentTools', '["packet-inspector"]'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + '/changelog/');
    await page.getByText('暂无更新日志。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshots, 'changelog-empty.png'), fullPage: true });

    await page.goto(base + '/');
    await page.getByText('11 results', { exact: true }).waitFor();
    assert.equal(await page.locator('a[href*="packet-inspector"]').count(), 0);
    await page.screenshot({ path: path.join(screenshots, 'tool-catalog.png'), fullPage: true });
    const search = page.getByRole('searchbox');
    await search.fill('packet');
    await page.getByText('0 results', { exact: true }).waitFor();

    await page.goto(base + '/desktop/');
    const release = JSON.parse(read('web/public/updates/desktop.json'));
    const download = page.locator('a').filter({ hasText: `Download .exe · v${release.latestVersion}` });
    await download.waitFor();
    assert.equal(await download.getAttribute('href'), release.packages['windows-amd64'].url);
    assert.ok((await download.textContent()).includes((release.packages['windows-amd64'].size / 1000000).toFixed(1) + ' MB'));
    await download.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshots, 'desktop-offline-download.png') });
    const removed = await page.goto(base + '/tools/packet-inspector/');
    assert.equal(removed.status(), 404);
    assert.deepEqual(errors, []);
    console.log('Web screenshots: ' + screenshots);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
