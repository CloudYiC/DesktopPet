/** Built-in tool availability and obsolete-module migration regression.
 * Every scenario uses a fresh browser profile and a synthetic WebView host;
 * no installed software, user preferences, files, sockets or clipboard are touched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const storageKey = 'yiyi.plugins.installed.v2';
const catalog = fs.readFileSync(path.resolve(__dirname, '../frontend/src/toolbox/catalog.ts'), 'utf8');
const tools = Array.from(catalog.matchAll(/\{ id: '([^']+)', name: '([^']+)'[^\n]*?category: '([^']+)'/g),
  ([, id, name, category]) => ({ id, name, category }));
assert.equal(tools.length, 20, 'the desktop contains 20 working built-in tools');
assert.equal(new Set(tools.map((tool) => tool.id)).size, 20);

// This is a source-contract check, not a native installation or database test.
// The UI scenarios below separately exercise restoration from an older host.
const nativeSource = fs.readFileSync(path.resolve(__dirname, '../native/src/Application.cpp'), 'utf8');
const allowedViews = nativeSource.match(/bool IsValidDashboardView[\s\S]*?\n}/)?.[0];
assert.ok(allowedViews && !allowedViews.includes('"marketplace"'), 'the host no longer accepts the removed page as new navigation');
assert.match(nativeSource, /restoreToolHome = setting == "marketplace";/, 'native startup recognizes the old saved page');
assert.match(nativeSource, /if \(restoreToolHome\) setting = "toolbox";/, 'native startup restores tool home');
assert.match(nativeSource, /if \(restoreToolHome\) lastToolCategory_\.clear\(\);/, 'native migration also clears the obsolete category');

const allFalse = JSON.stringify(Object.fromEntries(tools.map((tool) => [tool.id, false])));
const mixed = JSON.stringify(Object.fromEntries(tools.map((tool, index) => [tool.id, index % 2 === 0])));
const scenarios = [
  { name: 'clean-profile', saved: null, view: 'toolbox', category: '' },
  { name: 'all-disabled', saved: allFalse, view: 'toolbox', category: '' },
  { name: 'mixed-state', saved: mixed, view: 'toolbox', category: '' },
  { name: 'malformed-json', saved: '{this is not valid JSON', view: 'toolbox', category: '' },
  { name: 'legacy-marketplace', saved: allFalse, view: 'marketplace', category: 'system' },
];

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const output = path.resolve(__dirname, '../artifacts/builtin-tools');
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(({ scenario, storageKey }) => {
        if (scenario.saved !== null) localStorage.setItem(storageKey, scenario.saved);
        // Suppress the old one-time packet-inspector default migration as well.
        localStorage.setItem('yiyi.plugins.packet-inspector-default-local.v1', '1');
        const listeners = new Set();
        const app = { reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: true,
          autoHideEnabled: false, autoHideMinutes: 15, characters: [], activeCharacterId: 'builtin',
          workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
          lastDashboardView: scenario.view, lastToolCategory: scenario.category };
        const fixture = window.__builtinFixture = { requests: [], syncCount: 0, app };
        if (!window.chrome) window.chrome = {};
        window.chrome.webview = {
          addEventListener: (_type, listener) => listeners.add(listener),
          removeEventListener: (_type, listener) => listeners.delete(listener),
          postMessage: (request) => {
            fixture.requests.push(request);
            if (request.type === 'app.ready') {
              setTimeout(() => {
                fixture.syncCount += 1;
                listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...app } } }));
              }, 20);
              return;
            }
            if (request.type === 'workspace.navigation.update') {
              app.lastDashboardView = request.payload.view; app.lastToolCategory = request.payload.category;
              return;
            }
            // Opening system tools may request read-only snapshots. Return a
            // controlled unavailable result rather than querying this computer.
            if (request.payload?.requestId) setTimeout(() => listeners.forEach((listener) => listener({ data: {
              type: `${request.type}.error`, payload: { requestId: request.payload.requestId, message: '合成测试：未连接真实系统服务。' },
            } })), 10);
          },
        };
      }, { scenario, storageKey });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const main = () => page.getByRole('main').last();
      const cards = () => main().getByRole('article');
      const header = () => page.locator('header[aria-label="工具详情导航"]');
      async function verifyCatalog() {
        await main().getByPlaceholder('搜索工具…', { exact: true }).waitFor();
        assert.equal(await cards().count(), tools.length, `${scenario.name}: every tool remains visible`);
        assert.deepEqual((await cards().getByRole('heading').allTextContents()).sort(), tools.map((tool) => tool.name).sort());
        assert.equal(await main().getByRole('combobox').count(), 0, 'catalog has no enabled/available status filter');
        assert.equal(await main().getByRole('button', { name: /^(Enable|启用|停用|Disable|收藏|隐藏)$/ }).count(), 0);
        assert.equal(await main().getByText(/^(Local|Available|Popular|REACT LOCAL|C CORE)$/, { exact: true }).count(), 0, 'status/runtime badges are absent');
        assert.equal(await page.getByRole('complementary').first().getByRole('button', { name: /模块管理|插件商店/ }).count(), 0);
        for (const card of await cards().all()) {
          assert.equal(await card.getByRole('button').count(), 1, 'each tool has exactly one direct-open action');
          assert.equal((await card.locator('footer').innerText()).trim(), '打开', 'card footer contains no module state');
          assert.equal(await card.getByRole('button', { name: '打开', exact: true }).isEnabled(), true);
        }
      }
      try {
        await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
        await page.waitForFunction(() => window.__builtinFixture.syncCount > 0);
        // No navigation click: the remembered page must restore correctly itself.
        await verifyCatalog();
        await page.waitForFunction(() => window.__builtinFixture.app.lastDashboardView === 'toolbox' && window.__builtinFixture.app.lastToolCategory === '');
        if (scenario.view === 'marketplace') {
          const navigation = await page.evaluate(() => window.__builtinFixture.requests.filter((request) => request.type === 'workspace.navigation.update'));
          assert.ok(navigation.some(({ payload }) => payload.view === 'toolbox' && payload.category === ''), 'older host receives corrected tool-home navigation');
          assert.equal(navigation.some(({ payload }) => payload.view === 'marketplace'), false, 'removed page is never saved again');
        }
        await page.screenshot({ path: path.join(output, `${scenario.name}.png`), fullPage: true, animations: 'disabled' });
        for (const { name } of tools) {
          const card = cards().filter({ has: page.getByRole('heading', { name, exact: true }) });
          await card.getByRole('button', { name: '打开', exact: true }).click();
          await header().getByRole('heading', { name, exact: true }).waitFor();
          assert.equal(await header().count(), 1, `${scenario.name}/${name}: direct open succeeds without enable workflow`);
          await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
        }
        await verifyCatalog();
        const search = main().getByPlaceholder('搜索工具…', { exact: true });
        await page.keyboard.press('Control+k'); assert.equal(await search.evaluate((element) => document.activeElement === element), true);
        await search.fill('JSON'); assert.equal(await cards().count(), 1);
        await search.fill(''); assert.equal(await cards().count(), tools.length, 'search clearing restores all built-ins');
        const unexpected = await page.evaluate(() => window.__builtinFixture.requests.filter((request) => {
          if (['app.ready', 'workspace.navigation.update', 'system.snapshot', 'ports.list', 'software.list', 'network.poll', 'network.stop'].includes(request.type)) return false;
          if (/^(serial|mqtt|modbus)\.(enumerate|ports|poll|stop)$/.test(request.type)) return false;
          // Packet inspector parses its fixed sample on mount; leaving the
          // network workspace also requests safe session cleanup (stop only).
          return !(request.type === 'tool.execute' && request.payload.toolId === 'packet-inspector');
        }));
        assert.deepEqual(unexpected, [], 'opening built-ins causes no enable, deletion, network-start, send or unexpected host calls');
        assert.deepEqual(errors, [], `${scenario.name}: no uncaught browser errors`);
        console.log(`PASS: ${scenario.name}, all ${tools.length} tools directly opened.`);
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${scenario.name}-failure.png`), fullPage: true, animations: 'disabled' });
        throw error;
      } finally { await context.close(); }
    }
    console.log('PASS: legacy availability data is ignored; no enable/store/filter/badge UI; 100 direct opens, search, and old marketplace-to-tool-home restoration. Native migration source contracts also passed.');
    console.log(`Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
