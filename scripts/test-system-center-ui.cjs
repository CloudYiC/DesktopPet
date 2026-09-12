/** Read-only system-center regression. Every device value and host response is synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const state = { reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: false, autoHideEnabled: false, autoHideMinutes: 10, characters: [], activeCharacterId: 'builtin', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true, lastDashboardView: 'toolbox', lastToolCategory: 'system' };
    const snapshot = {
      operatingSystem: 'Windows 11 专业版', osEdition: 'Professional', osDisplayVersion: '24H2', osBuild: 26100, architecture: 'x64',
      computerName: 'SYNTHETIC-DESKTOP', userName: '测试用户', processorName: 'AMD Ryzen 7 7840HS with Radeon 780M Graphics', physicalCores: 8, logicalProcessors: 16, processorPackages: 1, processorMaxMegahertz: 3800, virtualizationEnabled: true,
      totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 9 * 1024 ** 3, memoryLoadPercent: 44, totalPageFileBytes: 24 * 1024 ** 3, availablePageFileBytes: 15 * 1024 ** 3,
      systemDrive: 'C:\\', systemDiskTotalBytes: 512 * 1024 ** 3, systemDiskFreeBytes: 268 * 1024 ** 3, manufacturer: 'Synthetic Devices', model: 'Desktop Reference', biosVersion: '1.0.0', biosDate: '2026-01-01',
      primaryGraphics: 'AMD Radeon 780M Graphics', primaryDisplayWidth: 1920, primaryDisplayHeight: 1080, primaryDisplayDpi: 120, timeZone: 'China Standard Time', localeName: 'zh-CN', activeNetworkAdapters: 2, primaryNetworkAdapter: 'Synthetic Ethernet Controller', primaryIpv4: '192.0.2.100', batteryPercent: 82, acLineStatus: 1, uptimeMilliseconds: 3 * 24 * 60 * 60 * 1000, installUnixSeconds: 1736899200,
    };
    const fixture = window.__systemFixture = { requests: [], failNext: false, state, snapshot, emit: null };
    fixture.emit = (patch = {}) => { Object.assign(state, patch); listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...state } } })); };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_event, listener) => listeners.add(listener),
      removeEventListener: (_event, listener) => listeners.delete(listener),
      postMessage(request) {
        fixture.requests.push(request);
        if (request.type === 'app.ready') { setTimeout(() => fixture.emit(), 10); return; }
        if (request.type === 'settings.update') { setTimeout(() => fixture.emit(request.payload), 10); return; }
        if (request.type !== 'system.snapshot') return;
        setTimeout(() => {
          const fail = fixture.failNext; fixture.failNext = false;
          listeners.forEach((listener) => listener({ data: { type: `system.snapshot.${fail ? 'error' : 'result'}`, payload: { requestId: request.payload.requestId, ...(fail ? { message: '合成读取失败，请重试。' } : { snapshot: fixture.snapshot }) } } }));
        }, 30);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/system-center'); fs.mkdirSync(output, { recursive: true });
  const workspace = () => page.getByTestId('system-center-workspace');
  const main = () => page.getByRole('main').last();
  const refresh = () => workspace().getByRole('button', { name: '刷新信息', exact: true });
  async function assertFit(label, strict = false) {
    await main().evaluate((element) => { element.scrollTop = 0; });
    const dimensions = await main().evaluate((element) => ({ w: element.clientWidth, sw: element.scrollWidth, h: element.clientHeight, sh: element.scrollHeight }));
    assert.ok(dimensions.sw <= dimensions.w + 1, `${label} no horizontal page scroll: ${JSON.stringify(dimensions)}`);
    if (strict) assert.ok(dimensions.sh <= dimensions.h + 1, `${label} no default vertical page scroll: ${JSON.stringify(dimensions)}`);
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18781/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '系统中心', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    await workspace().getByText('SYNTHETIC-DESKTOP', { exact: true }).waitFor();
    assert.equal(await workspace().locator('article').count(), 4);
    const colors = await workspace().locator('article').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).borderTopColor));
    assert.equal(new Set(colors).size, 4, 'four metric cards have distinct meaning-based accents');
    const originalDeviceFields = ['计算机名称', '当前用户', '设备厂商', '设备型号', 'Windows 版本', 'BIOS', '系统安装日期', '本次启动时间', '持续运行', '数据权限'];
    for (const label of originalDeviceFields) assert.equal(await workspace().getByRole('tabpanel').locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).count(), 1, `${label} retained`);
    await assertFit('1280x800-device', true);
    await page.setViewportSize({ width: 1280, height: 762 });
    await assertFit('1280x762-device', true);
    const tabFields = {
      '处理器与显示': ['处理器型号', '物理核心', '逻辑处理器', '处理器插槽', '标称频率', '固件虚拟化', '主显示适配器', '主屏幕'],
      '内存与存储': ['物理内存总量', '物理内存可用', '物理内存已用', '内存负载', '提交总限制', '提交可用', '提交已用', '系统盘', '系统盘总量', '系统盘可用'],
      '网络与环境': ['主要网络适配器', '主要 IPv4', '活动适配器', '时区', '系统区域', '供电状态'],
    };
    for (const [tab, fields] of Object.entries(tabFields)) {
      await workspace().getByRole('tab', { name: tab, exact: true }).click();
      assert.equal(await workspace().getByRole('tab', { name: tab, selected: true, exact: true }).count(), 1);
      for (const label of fields) assert.equal(await workspace().getByRole('tabpanel').locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).count(), 1, `${label} retained`);
      await assertFit(`1280x762-${tab}`, true);
    }
    const networkTab = workspace().getByRole('tab', { name: '网络与环境', exact: true });
    await networkTab.focus(); await page.keyboard.press('Home');
    assert.equal(await workspace().getByRole('tab', { name: '设备与系统', selected: true, exact: true }).count(), 1);
    await page.keyboard.press('ArrowRight');
    assert.equal(await workspace().getByRole('tab', { name: '处理器与显示', selected: true, exact: true }).count(), 1);
    assert.match(await workspace().getByRole('tabpanel').innerText(), /3\.80 GHz/);
    await page.keyboard.press('End');
    assert.match(await workspace().getByRole('tabpanel').innerText(), /192\.0\.2\.100/);
    await page.evaluate(() => { window.__systemFixture.failNext = true; });
    await refresh().click();
    await workspace().getByRole('alert').waitFor();
    assert.match(await workspace().getByRole('alert').innerText(), /合成读取失败/);
    assert.match(await workspace().getByRole('tabpanel').innerText(), /192\.0\.2\.100/, 'refresh errors retain last valid snapshot');
    await refresh().click(); await workspace().getByRole('alert').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__systemFixture.emit({ workspaceTextSize: 'large' }));
    await page.waitForFunction(() => document.documentElement.dataset.workspaceTextSize === 'large');
    for (const tab of ['设备与系统', ...Object.keys(tabFields)]) {
      await workspace().getByRole('tab', { name: tab, exact: true }).click();
      await assertFit(`1280x762-large-${tab}`, true);
    }
    await page.evaluate(() => {
      window.__systemFixture.snapshot.primaryNetworkAdapter = 'Synthetic-very-long-adapter-name-'.repeat(8);
      window.__systemFixture.snapshot.timeZone = 'Synthetic unusual long time zone name '.repeat(5);
      window.__systemFixture.snapshot.memoryLoadPercent = 150;
    });
    await refresh().click(); await refresh().waitFor();
    assert.equal(await workspace().getByRole('progressbar', { name: '物理内存使用率', exact: true }).getAttribute('aria-valuenow'), '100');
    await assertFit('1280x762-large-long-values');
    for (const [width, height] of [[1024, 768], [900, 650], [760, 600]]) {
      await page.setViewportSize({ width, height }); await assertFit(`${width}x${height}-large`);
    }
    const bridgeCalls = await page.evaluate(() => window.__systemFixture.requests.map((request) => request.type));
    assert.equal(bridgeCalls.some((type) => type.includes('terminate') || type.includes('cleanup') || type.includes('uninstall')), false, 'test issues no destructive host actions');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('System center UI: all synthetic regressions passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
