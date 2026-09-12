/** Isolated software review UI regression. All inventory, scan, reveal and cleanup calls are synthetic. */
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
    const entries = Array.from({ length: 80 }, (_, i) => ({ id: `synthetic-${i}`, displayName: i === 0 ? 'Synthetic WeGame' : `Synthetic Software ${i}`, displayVersion: '1.2.3', publisher: 'Synthetic Publisher', installLocation: `C:\\SyntheticApps\\App${i}`, registryPath: `HKEY_CURRENT_USER\\Software\\Synthetic\\App${i}`, estimatedSizeBytes: 1073741824, installLocationInferred: false, currentUser: true, noRemove: i === 2, windowsInstaller: false }));
    const makePlan = (id) => {
      const entry = entries.find((item) => item.id === id);
      return { token: `synthetic-plan-${id}`, softwareId: id, displayName: entry.displayName, residuals: Array.from({ length: 8 }, (_, i) => {
        const kind = i < 3 ? 'shortcut' : i < 5 ? 'program' : 'personal';
        const base = i < 3 ? 'C:\\SyntheticStartMenu' : i < 5 ? 'C:\\SyntheticApps' : 'C:\\SyntheticUserData';
        return { path: `${base}\\${id}\\Entry${i}${kind === 'shortcut' ? '.lnk' : ''}`, targetPath: kind === 'shortcut' ? `C:\\SyntheticApps\\${id}\\app.exe` : '', label: `Synthetic item ${i}`, kind, evidence: kind === 'shortcut' ? '快捷方式目标指向注册程序' : kind === 'program' ? '注册安装目录匹配' : '用户配置目录与程序名称匹配', confidence: kind === 'personal' ? 'medium' : 'high', sizeBytes: kind === 'shortcut' ? 2048 : i * 1048576, itemCount: 1, sizeTruncated: i === 7, defaultSelected: i < 2, personalData: kind === 'personal' };
      }), scanTruncated: false, scanWarnings: [] };
    };
    const f = window.__softwareFixture = { requests: [], clipboard: [], removedIds: [], plans: {}, delay: 30, failCleanup: false, state, emit: null };
    f.emit = (patch = {}) => { Object.assign(state, patch); listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...state } } })); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => f.clipboard.push(value) } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_event, listener) => listeners.add(listener),
      removeEventListener: (_event, listener) => listeners.delete(listener),
      postMessage(request) {
        f.requests.push(request);
        if (request.type === 'app.ready') { setTimeout(() => f.emit(), 10); return; }
        if (request.type === 'settings.update') { setTimeout(() => f.emit(request.payload), 10); return; }
        if (!request.type.startsWith('software.')) return;
        const p = request.payload || {};
        const delay = request.type === 'software.scan' ? f.delay : 20;
        // A canceled scan intentionally returns late: the UI must discard it by generation.
        setTimeout(() => {
          let result = {}, error = '';
          if (request.type === 'software.list') result = { entries: entries.filter((item) => !f.removedIds.includes(item.id)) };
          if (request.type === 'software.scan') { const plan = makePlan(p.softwareId); f.plans[plan.token] = plan; result = { plan }; }
          if (request.type === 'software.refresh') result = { plan: f.plans[p.planToken] };
          if (request.type === 'software.uninstall') { f.removedIds.push(p.softwareId); result = { operation: { succeeded: true, message: '合成卸载程序已启动', removedPaths: [], failedPaths: [] } }; }
          if (request.type === 'software.reveal') result = { operation: { succeeded: true, message: '合成打开位置', removedPaths: [], failedPaths: [] } };
          if (request.type === 'software.cleanup') {
            if (f.failCleanup) { error = '合成清理失败：请重新确认'; f.failCleanup = false; }
            else result = { operation: { succeeded: true, message: '合成所选项目已移入回收站', removedPaths: p.selectedPaths, failedPaths: [] } };
          }
          listeners.forEach((listener) => listener({ data: { type: `${request.type}.${error ? 'error' : 'result'}`, payload: { requestId: p.requestId, ...(error ? { message: error } : result) } } }));
        }, delay);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const nativeDialogs = []; page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  const output = path.resolve(__dirname, '../artifacts/software-uninstaller'); fs.mkdirSync(output, { recursive: true });
  const workspace = () => page.getByTestId('software-uninstaller-workspace');
  const main = () => page.getByRole('main').last();
  const table = () => page.getByRole('table', { name: '关联项目', exact: true });
  const button = (name) => workspace().getByRole('button', { name, exact: true });
  const calls = (type) => page.evaluate((type) => window.__softwareFixture.requests.filter((request) => request.type === type), type);
  async function scan() { await button('扫描关联项目').first().click(); await page.getByRole('tab', { name: '关联项目 8', exact: true }).waitFor(); }
  async function assertCentered(modal, name) {
    const box = await modal.boundingBox(); const viewport = page.viewportSize();
    assert.ok(box && Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2, `${name} centered across the entire client width`);
    assert.ok(box && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2, `${name} centered across the entire client height`);
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${name} stays inside the client`);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  }
  async function assertFit(name, strict) {
    await main().evaluate((element) => { element.scrollTop = 0; });
    const measurements = await main().evaluate((element) => ({ w: element.clientWidth, sw: element.scrollWidth, h: element.clientHeight, sh: element.scrollHeight }));
    assert.ok(measurements.sw <= measurements.w + 1, `${name} no horizontal outer scroll ${JSON.stringify(measurements)}`);
    if (strict) {
      assert.ok(measurements.sh <= measurements.h + 1, `${name} default workspace does not scroll vertically ${JSON.stringify(measurements)}`);
      const detail = await page.getByRole('region', { name: '软件详情', exact: true }).evaluate((element) => ({ h: element.clientHeight, sh: element.scrollHeight }));
      assert.ok(detail.sh <= detail.h + 1, `${name} detail fits without overflow ${JSON.stringify(detail)}`);
    }
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: '软件卸载', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    await page.getByRole('option', { name: 'Synthetic WeGame Synthetic Publisher', exact: true }).waitFor();
    assert.equal((await calls('software.scan')).length, 0, 'loading inventory does not implicitly scan');
    await button('卸载软件').click();
    const uninstallModal = page.getByRole('dialog', { name: '确认卸载软件', exact: true });
    await uninstallModal.waitFor();
    await assertCentered(uninstallModal, 'uninstall-confirmation');
    assert.equal((await calls('software.scan')).length, 0, 'opening confirmation does not implicitly scan');
    assert.equal((await calls('software.uninstall')).length, 0, 'opening confirmation never launches an uninstaller');
    await uninstallModal.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await calls('software.uninstall')).length, 0, 'canceling confirmation never launches an uninstaller');
    await scan();
    assert.equal(await table().getByRole('row').count(), 6, 'table shows five items plus header');
    assert.equal(await table().getByRole('checkbox', { checked: true }).count(), 2);
    const badgeColor = async (category) => table().locator(`[role="row"][data-category="${category}"] [data-category]`).first().evaluate((element) => getComputedStyle(element).backgroundColor);
    const shortcutColor = await badgeColor('shortcut');
    const programColor = await badgeColor('program');
    assert.notEqual(shortcutColor, programColor, 'shortcut and program evidence have distinct semantic colors');
    await assertFit('1280x800-comfortable', true);
    const inventory = await page.getByRole('listbox', { name: '软件列表', exact: true }).evaluate((element) => ({ h: element.clientHeight, sh: element.scrollHeight }));
    assert.ok(inventory.sh > inventory.h, 'software inventory scrolls internally');
    await button('下一页关联项目').click();
    assert.equal(await table().getByRole('row').count(), 4);
    assert.equal(await button('下一页关联项目').isDisabled(), true);
    await button('上一页关联项目').click();
    await button('复制路径').click();
    assert.match(await page.evaluate(() => window.__softwareFixture.clipboard.at(-1)), /Entry0\.lnk$/);
    await button('打开位置').click();
    await page.waitForFunction(() => window.__softwareFixture.requests.some((request) => request.type === 'software.reveal'));
    const revealed = (await calls('software.reveal')).at(-1).payload;
    assert.equal(revealed.planToken, 'synthetic-plan-synthetic-0');
    assert.match(revealed.path, /Entry0\.lnk$/);
    await button('个人数据 3').click();
    assert.equal(await table().getByRole('row').count(), 4);
    const personalColor = await badgeColor('personal');
    assert.notEqual(personalColor, shortcutColor); assert.notEqual(personalColor, programColor);
    await page.getByRole('checkbox', { name: '选择本页关联项目', exact: true }).check();
    assert.match(await workspace().locator('footer').first().innerText(), /已选 5 项/);
    await button('清理所选…').click();
    const modal = page.getByRole('dialog', { name: '确认清理关联项目', exact: true });
    await modal.waitFor();
    await assertCentered(modal, 'cleanup-confirmation');
    assert.equal(await modal.evaluate((element) => element.parentElement === document.body), true, 'cleanup uses the shared body portal');
    assert.equal(await modal.getByRole('button', { name: '取消', exact: true }).evaluate((element) => element === document.activeElement), true, 'cleanup defaults to cancellation');
    for (let step = 0; step < 7; step += 1) { await page.keyboard.press('Tab'); assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true, 'cleanup focus stays inside shared confirmation'); }
    assert.match(await modal.innerText(), /其中 3 项包含个人数据/);
    await page.getByLabel('确认清理的软件名称', { exact: true }).fill('Synthetic');
    assert.equal(await modal.getByRole('button', { name: '确认移入回收站', exact: true }).isDisabled(), true);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await calls('software.cleanup')).length, 0, 'modal cancellation never cleans');
    await button('全部 8').click();
    await page.evaluate(() => window.__softwareFixture.emit({ workspaceTextSize: 'large' }));
    await page.waitForFunction(() => document.documentElement.dataset.workspaceTextSize === 'large');
    await assertFit('1280x800-large', true);
    await page.setViewportSize({ width: 1280, height: 762 });
    await assertFit('1280x762-large', true);
    await button('清理所选…').click();
    await modal.waitFor();
    await assertCentered(modal, 'cleanup-confirmation-1280x762-large');
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('tab', { name: '软件信息', exact: true }).click();
    assert.match(await page.getByRole('tabpanel').innerText(), /HKEY_CURRENT_USER/);
    await assertFit('1280x800-info-large', true);
    await page.getByRole('tab', { name: '关联项目 8', exact: true }).click();
    await page.evaluate(() => window.__softwareFixture.emit({ workspaceTextSize: 'comfortable' }));
    for (const [width, height] of [[1280, 762], [1024, 800], [900, 650], [760, 600]]) {
      await page.setViewportSize({ width, height });
      await assertFit(`${width}x${height}`, width >= 1024);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await button('卸载软件').click();
    await uninstallModal.waitFor();
    await uninstallModal.getByRole('button', { name: '启动卸载', exact: true }).click();
    await uninstallModal.waitFor({ state: 'hidden' });
    await button('复查残留').waitFor();
    await button('刷新软件列表').click();
    await button('复查残留').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Synthetic WeGame', exact: true }).count(), 1, 'removed registration keeps reviewed software workspace');
    await button('复查残留').click();
    await page.waitForFunction(() => window.__softwareFixture.requests.some((request) => request.type === 'software.refresh'));
    await button('清理所选…').click();
    await page.getByLabel('确认清理的软件名称', { exact: true }).fill('Synthetic WeGame');
    await page.evaluate(() => { window.__softwareFixture.failCleanup = true; });
    await modal.getByRole('button', { name: '确认移入回收站', exact: true }).click();
    await modal.getByRole('alert').waitFor();
    await modal.getByRole('button', { name: '确认移入回收站', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const cleanup = (await calls('software.cleanup')).at(-1).payload;
    assert.equal(cleanup.confirmed, true); assert.equal(cleanup.typedName, 'Synthetic WeGame');
    assert.ok(cleanup.selectedPaths.every((value) => value.startsWith('C:\\Synthetic')));
    assert.equal(await button('复查残留').count(), 1, 'partial selection cleanup retains the cached native plan');
    const remainingCount = 8 - new Set(cleanup.selectedPaths).size;
    assert.equal(await page.getByRole('tab', { name: `关联项目 ${remainingCount}`, exact: true }).count(), 1, 'unselected candidates remain reviewable after registration disappears');
    await page.getByRole('option', { name: 'Synthetic Software 1 Synthetic Publisher', exact: true }).click();
    await page.evaluate(() => { window.__softwareFixture.delay = 900; });
    await button('扫描关联项目').first().click();
    await button('取消扫描').waitFor();
    await page.getByRole('option', { name: 'Synthetic Software 2 Synthetic Publisher', exact: true }).click();
    await page.waitForTimeout(1100);
    assert.ok((await calls('software.scan.cancel')).length >= 1);
    assert.equal(await page.getByRole('heading', { name: 'Synthetic Software 2', exact: true }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: /^关联项目 8$/ }).count(), 0, 'late canceled scan cannot replace current plan');
    assert.equal(await button('卸载软件').isDisabled(), true, 'noRemove remains enforced in UI');
    assert.deepEqual(nativeDialogs, [], 'software confirmations never use browser-native alert/confirm dialogs');
    assert.deepEqual(errors, []);
    console.log('PASS software uninstall UI: semantic colors, five-row pagination, filters, fixed detail, internal inventory scrolling, path reveal, client-centered uninstall/named cleanup confirmations, cancellation, failed cleanup feedback, post-uninstall cached plan, scan cancellation and late-response isolation. Synthetic calls only.');
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
