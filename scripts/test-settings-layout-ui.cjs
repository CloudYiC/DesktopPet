/** Settings layout and preference bridge regression in an isolated WebView profile.
 * Host state and settings persistence are entirely synthetic; user preferences are untouched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const now = Date.now();
    const app = {
      reminders: [
        { id: 8101, title: '合成今日提醒', dueAt: now + 60000, completed: false, notified: false, repeatRule: 'none', priority: 'important' },
        { id: 8102, title: '合成以后提醒', dueAt: now + 3 * 86400000, completed: false, notified: false, repeatRule: 'daily', priority: 'normal' },
      ],
      now, petName: '可爱依依', soundEnabled: false, speechEnabled: true, autoHideEnabled: false, autoHideMinutes: 17,
      characters: [{ id: 'builtin', name: '经典小鼠', imageUrl: '/assets/milo-sprite.png', layout: 'sheet', builtIn: true }],
      activeCharacterId: 'builtin', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
      lastDashboardView: 'today', lastToolCategory: '',
    };
    const fixture = window.__settingsFixture = { app, requests: [], syncCount: 0, emit: null };
    fixture.emit = (patch = {}) => {
      Object.assign(app, patch);
      fixture.syncCount += 1;
      listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...app, now: Date.now() } } }));
    };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        fixture.requests.push(request);
        if (request.type === 'app.ready') setTimeout(() => fixture.emit(), 20);
        if (request.type === 'settings.update') setTimeout(() => fixture.emit(request.payload), 20);
        if (request.type === 'workspace.navigation.update') {
          app.lastDashboardView = request.payload.view; app.lastToolCategory = request.payload.category;
        }
      },
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/settings-layout');
  fs.mkdirSync(output, { recursive: true });
  const tabs = ['常规', '本机数据', '关于'];
  const sidebar = () => page.getByRole('complementary').first();
  const main = () => page.getByRole('main').last();
  const mainHeader = () => main().locator(':scope > header');
  const settings = () => page.getByTestId('assistant-settings');
  const tab = (name) => settings().getByRole('tab', { name, exact: true });
  const button = (name) => settings().getByRole('button', { name, exact: true });
  async function openSettings() {
    await sidebar().getByRole('button', { name: /助手设置/ }).click();
    await settings().waitFor();
  }
  async function changeFixture(patch) {
    await page.evaluate((patch) => window.__settingsFixture.emit(patch), patch);
    if (patch.workspaceTextSize) await page.waitForFunction((value) => document.documentElement.dataset.workspaceTextSize === value, patch.workspaceTextSize);
  }
  async function geometry(locator) {
    return locator.evaluate((element) => {
      const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height, width: box.width,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        padding: style.padding, overflowX: style.overflowX, overflowY: style.overflowY };
    });
  }
  async function assertInsets(label) {
    const frame = await geometry(main()); const heading = await geometry(mainHeader()); const side = await geometry(sidebar());
    assert.equal(frame.padding, '12px 16px 16px', `${label} uses unified insets`);
    assert.equal(Math.round(heading.y), 12, `${label} header starts 12px below the client top`);
    assert.equal(Math.round(heading.x - side.right), 16, `${label} has a 16px sidebar/content gap`);
  }
  async function assertSettingsLayout(label) {
    await assertInsets(label);
    const frame = await geometry(main()); const content = await geometry(settings());
    const { width, height } = page.viewportSize();
    assert.ok(frame.scrollWidth <= frame.clientWidth + 1, `${label} has no horizontal overflow`);
    assert.ok(content.right <= width + 1, `${label} settings panel stays inside client width`);
    if (width >= 1024) {
      assert.ok(frame.scrollHeight <= frame.clientHeight + 1, `${label} has no unnecessary outer vertical scroll ${JSON.stringify(frame)}`);
      assert.ok(content.bottom <= height + 1, `${label} fits default client height`);
    } else {
      assert.ok(['auto', 'scroll'].includes(frame.overflowY), 'narrow settings retain natural scrolling, not overflow hiding');
    }
    for (const action of await settings().getByRole('button').all()) {
      await action.scrollIntoViewIfNeeded();
      const box = await geometry(action);
      assert.ok(box.right <= width + 1 && box.x >= 0 && box.bottom <= height + 1 && box.y >= 0, `${label} button remains reachable: ${await action.innerText()}`);
      assert.ok(box.height >= 36, `${label} settings button preserves a comfortable pointer target`);
    }
    if (await settings().getByRole('group', { name: '主题颜色', exact: true }).count()) {
      const choices = await settings().getByRole('group', { name: '主题颜色', exact: true }).getByRole('button').all();
      const boxes = await Promise.all(choices.map(geometry));
      assert.equal(boxes.length, 3);
      assert.ok(boxes.every((box) => Math.abs(box.y - boxes[0].y) <= 1), 'the three theme choices share one row');
      assert.ok((await geometry(settings().getByRole('switch', { name: '记住上次页面', exact: true }))).height >= 36);
    }
    await main().evaluate((element) => { element.scrollTop = 0; });
    assert.equal(await mainHeader().getByRole('heading', { name: '助手设置', exact: true }).count(), 1);
    assert.equal(await mainHeader().locator('p').count(), 0, 'assistant header has no repeated introduction');
    assert.equal((await mainHeader().innerText()).includes('CLOUDYI ASSISTANT'), true);
    assert.equal(await settings().getByRole('tabpanel').count(), 1, 'only the selected settings tab is mounted');
    assert.equal(await settings().getByRole('tab').count(), tabs.length, 'settings retain exactly three tabs');
    for (const name of tabs) assert.equal(await tab(name).count(), 1, `settings tab remains accessible: ${name}`);
    assert.equal(await sidebar().getByRole('button', { name: /模块管理|插件商店/ }).count(), 0, 'the obsolete module entry is removed');
    assert.equal(await settings().getByRole('button', { name: /打开模块管理|启用模块|停用模块/ }).count(), 0, 'settings do not restore a module manager');
  }
  async function screenshot(name) {
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: path.join(output, `${name}-${width}x${height}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await page.waitForFunction(() => window.__settingsFixture?.syncCount > 0);
    await openSettings();
    for (const [theme, name] of [['warm', '暖杏'], ['cloud', '云青'], ['rose', '柔粉']]) {
      await button(name).click();
      await page.waitForFunction((theme) => document.documentElement.dataset.workspaceTheme === theme, theme);
      assert.equal(await button(name).getAttribute('aria-pressed'), 'true');
    }
    for (const [size, name] of [['compact', '紧凑'], ['comfortable', '标准'], ['large', '放大']]) {
      await button(name).click();
      await page.waitForFunction((size) => document.documentElement.dataset.workspaceTextSize === size, size);
      assert.equal(await button(name).getAttribute('aria-pressed'), 'true');
    }
    const remember = settings().getByRole('switch', { name: '记住上次页面', exact: true });
    await remember.click(); await page.waitForFunction(() => window.__settingsFixture.app.openLastView === false);
    assert.equal(await remember.getAttribute('aria-checked'), 'false');
    await remember.click(); await page.waitForFunction(() => window.__settingsFixture.app.openLastView === true);
    assert.equal(await remember.getAttribute('aria-checked'), 'true');
    const updates = await page.evaluate(() => window.__settingsFixture.requests.filter((request) => request.type === 'settings.update'));
    assert.equal(updates.length, 8, 'three themes, three sizes, and two remember-view changes reach the host');
    const expectedKeys = ['petName', 'soundEnabled', 'speechEnabled', 'autoHideEnabled', 'autoHideMinutes', 'workspaceTheme', 'workspaceTextSize', 'openLastView'].sort();
    for (const { payload } of updates) {
      assert.deepEqual(Object.keys(payload).sort(), expectedKeys, 'settings.update sends the complete native-compatible record');
      assert.equal(payload.petName, '可爱依依'); assert.equal(payload.soundEnabled, false); assert.equal(payload.speechEnabled, true);
      assert.equal(payload.autoHideEnabled, false); assert.equal(payload.autoHideMinutes, 17);
    }
    await tab('常规').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await tab('本机数据').getAttribute('aria-selected'), 'true', 'arrow key selects the next settings tab');
    await page.keyboard.press('End'); assert.equal(await tab('关于').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home'); assert.equal(await tab('常规').getAttribute('aria-selected'), 'true');

    for (const [width, height] of [[1280, 800], [1280, 720], [1024, 720], [760, 600]]) {
      await page.setViewportSize({ width, height }); await openSettings();
      for (const size of ['comfortable', 'large']) {
        await changeFixture({ workspaceTheme: 'warm', workspaceTextSize: size });
        for (const name of tabs) {
          await tab(name).click(); await assertSettingsLayout(`${name}/${size}/${width}×${height}`);
          await screenshot(`${name}-${size}`);
        }
      }
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await changeFixture({ workspaceTheme: 'warm', workspaceTextSize: 'comfortable' });
    const petNav = sidebar().getByRole('navigation', { name: '小助手功能', exact: true });
    for (const [navigation, required] of [
      [/^⌁ 今天/, ['今天接下来要做', '合成今日提醒']],
      [/^◷ 全部事项/, ['全部未完成事项', '合成今日提醒', '合成以后提醒']],
      [/^✦ 可爱依依状态/, ['和可爱依依互动', '挥挥手', '休息一下']],
      [/^⚙ 设置/, ['角色衣柜', '名字与提醒声音', '自动收起']],
    ]) {
      await petNav.getByRole('button', { name: navigation }).click(); await assertInsets(String(navigation));
      const text = await main().innerText();
      for (const expected of required) assert.ok(text.includes(expected), `pet content remains available: ${expected}`);
      assert.equal(await mainHeader().locator('p').count(), 1, 'pet header explanation is retained');
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS: 3 tabs × 4 sizes × 2 typography preferences; all settings controls reachable, compact unified headers, 8 complete settings.update payloads, keyboard tab navigation, no obsolete module manager, and preserved today/all/status/pet-settings content.');
    console.log(`Screenshots: ${output}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
