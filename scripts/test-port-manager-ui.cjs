/** Synthetic host only: never enumerates ports or terminates a real process. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const state = { reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: false, autoHideEnabled: false, autoHideMinutes: 10, characters: [], activeCharacterId: 'builtin', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true, lastDashboardView: 'toolbox', lastToolCategory: 'system' };
    const entries = Array.from({ length: 64 }, (_, index) => ({ protocol: index % 3 ? 'TCP' : 'UDP', localAddress: '255.255.255.255', localPort: 65535 - index, remoteAddress: index % 3 ? '203.0.113.254' : '—', remotePort: index % 3 ? 49152 + index : 0, state: index % 3 ? index % 2 ? '已连接' : '等待释放' : '监听', processId: index === 2 ? 4 : 5000 + index, processName: index === 0 ? 'TestRelay.exe' : index === 2 ? 'System' : index === 3 ? 'svchost.exe' : `LongApplicationNameWithNoWhitespace-${index}-测试进程.exe` }));
    const fixture = window.__portsFixture = { requests: [], removed: [], failList: false, failTerminate: false, delay: 250, state };
    fixture.emit = (patch = {}) => { Object.assign(state, patch); listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...state } } })); };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage(request) {
        fixture.requests.push(request);
        if (request.type === 'app.ready') { setTimeout(() => fixture.emit(), 10); return; }
        if (request.type === 'settings.update') { fixture.emit(request.payload); return; }
        if (!request.type.startsWith('ports.')) return;
        setTimeout(() => {
          let error = '', result = {};
          if (request.type === 'ports.list') {
            if (fixture.failList) { fixture.failList = false; error = '模拟端口读取失败'; }
            else result = { entries: entries.filter((entry) => !fixture.removed.includes(entry.processId)) };
          }
          if (request.type === 'ports.terminate') {
            if (fixture.failTerminate) { fixture.failTerminate = false; error = '模拟端口归属变化，未结束进程'; }
            else { fixture.removed.push(request.payload.processId); result = { message: '模拟进程已结束' }; }
          }
          listeners.forEach((listener) => listener({ data: { type: `${request.type}.${error ? 'error' : 'result'}`, payload: { requestId: request.payload.requestId, ...(error ? { message: error } : result) } } }));
        }, request.type === 'ports.terminate' ? fixture.delay : 30);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = [], nativeDialogs = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  const output = path.resolve(__dirname, '../artifacts/port-manager'); fs.mkdirSync(output, { recursive: true });
  const workspace = () => page.getByTestId('port-manager-workspace');
  const modal = () => page.getByRole('dialog', { name: '结束进程？', exact: true });
  const calls = (type) => page.evaluate((type) => window.__portsFixture.requests.filter((request) => request.type === type), type);
  async function assertFit(name) {
    const sizes = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="port-manager-workspace"]');
      const scroll = document.querySelector('[data-testid="port-table-scroll"]');
      const rect = scroll.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth, rootRight: root.getBoundingClientRect().right, rootBottom: root.getBoundingClientRect().bottom, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, actionsFit: [...scroll.querySelectorAll('button')].every((button) => { const box = button.getBoundingClientRect(); return box.width >= 80 && box.right <= rect.left + scroll.clientWidth + 1; }) };
    });
    assert.ok(sizes.bodyWidth <= sizes.width && sizes.rootRight <= sizes.width, `${name}: no page horizontal overflow`);
    assert.ok(sizes.rootBottom <= sizes.height + 1, `${name}: workspace stays inside client height`);
    assert.ok(sizes.scrollWidth <= sizes.clientWidth + 1, `${name}: no bottom scrollbar`);
    assert.ok(sizes.scrollHeight > sizes.clientHeight, `${name}: only the long list scrolls vertically`);
    assert.ok(sizes.actionsFit, `${name}: every action button fully fits`);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  }
  async function centered(name) {
    const box = await modal().boundingBox(), viewport = page.viewportSize();
    assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2 && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2, `${name}: modal centered across whole client, not right pane`);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '端口管理', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    await page.getByText('显示 64 / 64 条', { exact: true }).waitFor();
    assert.equal(await page.getByText('结束进程需要二次确认；原生层会重新核对端口归属，并拒绝关键 Windows 进程。', { exact: true }).count(), 0);
    assert.equal(await workspace().getByRole('button', { name: '系统保护', exact: true }).count(), 2);
    for (const button of await workspace().getByRole('button', { name: '系统保护', exact: true }).all()) assert.equal(await button.isDisabled(), true);
    for (const size of ['comfortable', 'large']) {
      await page.evaluate((size) => window.__portsFixture.emit({ workspaceTextSize: size }), size);
      for (const [width, height] of [[1280, 762], [1280, 800], [1024, 762], [920, 762], [760, 650]]) {
        await page.setViewportSize({ width, height }); await assertFit(`${width}x${height}-${size}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => window.__portsFixture.emit({ workspaceTextSize: 'comfortable' }));
    const tcpColor = await page.locator('[data-protocol="TCP"]').first().evaluate((element) => getComputedStyle(element).backgroundColor);
    const udpColor = await page.locator('[data-protocol="UDP"]').first().evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(tcpColor, udpColor, 'TCP and UDP have distinct semantic colors');
    await page.getByLabel('协议筛选').selectOption('TCP');
    assert.equal(await page.locator('[data-protocol="UDP"]').count(), 0);
    await page.getByLabel('协议筛选').selectOption('all');
    await page.getByLabel('搜索端口、进程或 PID', { exact: true }).fill('TestRelay');
    assert.equal(await workspace().getByRole('button', { name: '结束进程', exact: true }).count(), 1);
    await workspace().getByRole('button', { name: '结束进程', exact: true }).click();
    await modal().waitFor(); await centered('terminate-confirmation');
    assert.equal(await modal().getByRole('button', { name: '取消', exact: true }).evaluate((element) => document.activeElement === element), true, 'cancel focused by default');
    assert.ok((await modal().innerText()).includes('TestRelay.exe') && (await modal().innerText()).includes('5000'));
    assert.equal((await calls('ports.terminate')).length, 0, 'opening dialog never terminates');
    for (let index = 0; index < 7; index += 1) { await page.keyboard.press('Tab'); assert.equal(await modal().evaluate((element) => element.contains(document.activeElement)), true); }
    await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
    assert.equal((await calls('ports.terminate')).length, 0);
    assert.equal(await workspace().getByRole('button', { name: '结束进程', exact: true }).evaluate((element) => document.activeElement === element), true, 'cancel restores initiating focus');
    await workspace().getByRole('button', { name: '结束进程', exact: true }).click();
    await page.evaluate(() => { window.__portsFixture.failTerminate = true; });
    await modal().getByRole('button', { name: '确认结束', exact: true }).click();
    await page.keyboard.press('Escape'); assert.equal(await modal().isVisible(), true, 'busy request cannot be canceled ambiguously');
    await modal().getByRole('alert').waitFor(); await centered('terminate-error');
    assert.equal((await calls('ports.terminate')).length, 1);
    await modal().getByRole('button', { name: '确认结束', exact: true }).click();
    await modal().waitFor({ state: 'hidden' });
    const requests = await calls('ports.terminate'); assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.payload.confirmed === true && request.payload.processId === 5000 && request.payload.processName === 'TestRelay.exe'));
    await page.getByLabel('搜索端口、进程或 PID', { exact: true }).fill('');
    await page.getByText('显示 63 / 63 条', { exact: true }).waitFor();
    await page.evaluate(() => { window.__portsFixture.failList = true; });
    await workspace().getByRole('button', { name: '刷新', exact: true }).click();
    await workspace().getByRole('alert').waitFor();
    assert.equal(await page.getByText('显示 63 / 63 条', { exact: true }).count(), 1, 'read failure retains previous data');
    await assertFit('refresh-failed-retained-data');
    await workspace().getByRole('button', { name: '刷新', exact: true }).click();
    await workspace().getByRole('alert').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []);
    console.log('PASS port manager: bounded scrolling, full actions at 5 sizes and both text preferences, protocol colors/filtering, centered focus-safe confirmation, cancel/no native dialog, protected rows, failed operation/retry, exact confirmed target. Synthetic host only.');
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
