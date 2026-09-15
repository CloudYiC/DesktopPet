/** Synthetic WebView regression: never changes real preferences or opens websites. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const app = {
      reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: false,
      financeWebsiteUrl: '', learningWebsiteUrl: '',
      characters: [{ id: 'builtin', name: '经典小鼠', imageUrl: '/assets/milo-sprite.png', layout: 'sheet', builtIn: true }],
      activeCharacterId: 'builtin', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
      lastDashboardView: 'status', lastToolCategory: '',
    };
    const fixture = window.__shortcutsFixture = { app, requests: [], saved: 0, syncCount: 0, failNext: false };
    fixture.emit = (type, payload) => listeners.forEach((listener) => listener({ data: { type, payload } }));
    fixture.sync = (patch = {}) => {
      Object.assign(app, patch); fixture.syncCount += 1;
      fixture.emit('state.sync', { ...app, now: Date.now() });
    };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        fixture.requests.push(request);
        if (request.type === 'app.ready') {
          // A pending desktop click is delivered before the initial state.
          fixture.emit('workspace.shortcuts.open', { shortcut: 'learning' });
          setTimeout(() => fixture.sync(), 20);
        }
        if (request.type === 'shortcuts.save') {
          setTimeout(() => {
            if (fixture.failNext) {
              fixture.failNext = false;
              fixture.emit('shortcuts.save.error', { requestId: request.payload.requestId, message: '合成保存失败，请重试。' });
              return;
            }
            const result = {
              financeWebsiteUrl: request.payload.financeWebsiteUrl,
              learningWebsiteUrl: request.payload.learningWebsiteUrl,
            };
            fixture.saved += 1;
            fixture.sync(result);
            fixture.emit('shortcuts.save.result', { ...result, requestId: request.payload.requestId });
          }, 60);
        }
      },
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const card = () => page.getByTestId('pet-website-settings');
  const finance = () => card().getByLabel('我的理财', { exact: true });
  const learning = () => card().getByLabel('个人学习', { exact: true });
  const save = () => card().getByRole('button', { name: '保存入口', exact: true });
  const saveCount = () => page.evaluate(() => window.__shortcutsFixture.requests.filter(({ type }) => type === 'shortcuts.save').length);
  const output = path.resolve(__dirname, '../artifacts/pet-website-settings');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await card().waitFor();
    await page.waitForFunction(() => window.__shortcutsFixture.syncCount > 0);
    await page.waitForFunction(() => document.activeElement?.id === 'learning-website-url');
    assert.equal(await learning().evaluate((element) => element === document.activeElement), true, 'pending shortcut beats restored status page and focuses the requested field');
    assert.equal(await page.getByText('自动收起', { exact: true }).count(), 0, 'auto tuck settings are absent');
    assert.equal(await finance().inputValue(), '');
    assert.equal(await learning().inputValue(), '');
    await finance().fill('  http://192.168.1.20:8080/finance  ');
    await learning().fill('https://learning.internal/course');
    await page.evaluate(() => window.__shortcutsFixture.sync({ soundEnabled: true }));
    assert.equal(await finance().inputValue(), '  http://192.168.1.20:8080/finance  ', 'incoming snapshots retain dirty drafts');
    assert.equal(await learning().inputValue(), 'https://learning.internal/course');
    assert.equal(await saveCount(), 0, 'editing does not save or open a website');
    await save().click();
    await page.waitForFunction(() => window.__shortcutsFixture.saved === 1);
    await card().getByRole('status').filter({ hasText: '网站入口已保存' }).waitFor();
    assert.equal(await finance().inputValue(), 'http://192.168.1.20:8080/finance');
    const saved = await page.evaluate(() => window.__shortcutsFixture.requests.find(({ type }) => type === 'shortcuts.save').payload);
    assert.equal(saved.financeWebsiteUrl, 'http://192.168.1.20:8080/finance', 'saving trims an intranet address');
    assert.equal(saved.learningWebsiteUrl, 'https://learning.internal/course');
    assert.equal(await page.getByRole('main').last().locator(':scope > [class*="errorMessage"]').count(), 0, 'save feedback does not add a top-level banner');
    const beforeFailures = await saveCount();
    for (const unsafe of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'http:example.com', 'https://user:pass@example.com', 'https://exam ple.com', 'https://example.com\\evil']) {
      await finance().fill(unsafe); await save().click();
      assert.equal(await finance().getAttribute('aria-invalid'), 'true', `${unsafe} is rejected in place`);
      assert.equal(await saveCount(), beforeFailures, 'invalid address never reaches the host');
    }
    await finance().fill('http://finance.internal');
    await page.evaluate(() => { window.__shortcutsFixture.failNext = true; });
    await save().click();
    await card().getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
    assert.equal(await finance().inputValue(), 'http://finance.internal', 'host failure preserves editable input');
    await page.evaluate(() => window.__shortcutsFixture.sync());
    assert.equal(await finance().inputValue(), 'http://finance.internal', 'failed save remains dirty on refresh');
    await save().click(); await page.waitForFunction(() => window.__shortcutsFixture.saved === 2);
    await finance().fill(''); await learning().fill(''); await save().click();
    await page.waitForFunction(() => window.__shortcutsFixture.saved === 3);
    assert.deepEqual(await page.evaluate(() => [window.__shortcutsFixture.app.financeWebsiteUrl, window.__shortcutsFixture.app.learningWebsiteUrl]), ['', ''], 'empty fields clear both optional entries');
    await page.evaluate(() => window.__shortcutsFixture.emit('workspace.toolbox.open'));
    await card().waitFor({ state: 'detached' });
    await page.getByPlaceholder(/搜索工具/).waitFor();
    assert.equal(await page.getByPlaceholder(/搜索工具/).count(), 1, 'open-toolbox request goes to the tool home');
    await page.evaluate(() => window.__shortcutsFixture.emit('workspace.shortcuts.open', { shortcut: 'finance' }));
    await card().waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'finance-website-url');
    for (const [width, height] of [[1280, 762], [1024, 720], [760, 600]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.__shortcutsFixture.sync({ workspaceTextSize: 'large' }));
      const measurements = await card().evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      assert.ok(measurements.left >= 0 && measurements.right <= width + 1, `card fits ${width} wide client`);
      assert.ok(measurements.scrollWidth <= measurements.clientWidth + 1, 'URL fields never cause horizontal overflow');
      await save().scrollIntoViewIfNeeded();
      const button = await save().boundingBox();
      assert.ok(button.height >= 36 && button.y >= 0 && button.y + button.height <= height + 1, 'save button remains reachable at large text size');
      await page.screenshot({ path: path.join(output, `${width}x${height}.png`) });
    }
    assert.equal(await page.evaluate(() => window.__shortcutsFixture.requests.some(({ type }) => /shortcuts\.open|window\.openExternal/.test(type))), false, 'settings tests never open a browser or destination');
    assert.deepEqual(errors, []);
    console.log('PASS: startup and live shortcut focus, direct toolbox entry, independent URL drafts, explicit saves, URL rejection, native error/retry, empty clears, local feedback, no auto tuck, three responsive widths.');
    console.log(`Screenshots: ${output}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
