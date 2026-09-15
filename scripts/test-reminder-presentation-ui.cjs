/**
 * Reminder browser regression using an isolated, synthetic WebView host.
 * The real ten-second wait checks the dashboard's requested due time; the test
 * then supplies native events. It does NOT test Windows timers, window z-order,
 * monitor placement, installation, or the user's reminder database.
 *
 * Run against a frontend production preview using PACKET_TEST_URL and, when
 * needed, PACKET_TEST_BROWSER. Screenshots contain synthetic/public assets only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const singleImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240" viewBox="0 0 200 240"><rect x="38" y="32" width="124" height="156" rx="48" fill="#168b85"/><circle cx="77" cy="91" r="9" fill="white"/><circle cx="123" cy="91" r="9" fill="white"/><path d="M76 127 Q100 148 124 127" fill="none" stroke="white" stroke-width="7"/><path d="M55 173 L44 218 M145 173 L156 218" stroke="#168b85" stroke-width="16" stroke-linecap="round"/></svg>')}`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  const errors = [], nativeDialogs = [];
  const output = path.resolve(__dirname, '../artifacts/reminder-presentation');
  fs.mkdirSync(output, { recursive: true });
  await context.addInitScript(({ singleImage }) => {
    const listeners = new Set();
    const builtin = { id: 'builtin', name: '经典小鼠', imageUrl: '/assets/milo-sprite.png', layout: 'sheet', builtIn: true };
    const single = { id: 'synthetic-single', name: '合成测试角色', imageUrl: singleImage, layout: 'single', builtIn: false };
    const app = { reminders: [], now: Date.now(), petName: '测试依依', soundEnabled: false, speechEnabled: false,
      autoHideEnabled: true, autoHideMinutes: 10, characters: [builtin, single], activeCharacterId: single.id,
      workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
      lastDashboardView: 'toolbox', lastToolCategory: '' };
    const fixture = window.__reminderFixture = { app, builtin, single, calls: [], events: [], emit: null, sync: null };
    fixture.emit = (type, payload) => {
      fixture.events.push({ type, at: Date.now() });
      listeners.forEach((listener) => listener({ data: { type, payload } }));
    };
    fixture.sync = (patch = {}) => {
      Object.assign(app, patch, { now: Date.now() });
      fixture.emit('state.sync', { ...app });
    };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        fixture.calls.push({ ...request, receivedAt: Date.now() });
        if (request.type === 'app.ready') setTimeout(() => fixture.sync(), 20);
        if (request.type === 'reminder.complete') setTimeout(() => {
          fixture.sync({ reminders: app.reminders.map((item) => item.id === request.payload.id ? { ...item, completed: true } : item) });
          fixture.emit('reminder.completed', { id: request.payload.id });
        }, 20);
        if (request.type === 'reminder.snooze') setTimeout(() => {
          fixture.sync({ reminders: app.reminders.map((item) => item.id === request.payload.id
            ? { ...item, notified: false, dueAt: Date.now() + request.payload.minutes * 60_000 } : item) });
          fixture.emit('reminder.dismissed', { id: request.payload.id });
        }, 20);
      },
    };
  }, { singleImage });

  const observe = (page) => {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  };
  const dashboard = await context.newPage(); observe(dashboard);
  const pet = await context.newPage(); observe(pet);
  const url = new URL(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/');
  const modeUrl = (mode) => { const result = new URL(url); result.search = `?mode=${mode}`; return result.href; };
  const requests = (page, type) => page.evaluate((type) => window.__reminderFixture.calls.filter((item) => item.type === type), type);
  const emit = (page, type, payload) => page.evaluate(({ type, payload }) => window.__reminderFixture.emit(type, payload), { type, payload });
  const sync = (page, patch) => page.evaluate((patch) => window.__reminderFixture.sync(patch), patch);
  const character = () => pet.getByRole('button', { name: '点击测试依依打开互动菜单，拖动可移动位置', exact: true });
  const placard = () => pet.getByRole('alert');

  async function checkPlacard(reminder, expectedPriority) {
    await placard().waitFor();
    assert.match(await placard().innerText(), new RegExp(reminder.title));
    assert.equal(await placard().getAttribute('aria-live'), 'assertive');
    assert.equal(await character().getAttribute('tabindex'), '-1', 'the presenting character cannot open an interaction menu');
    const stageClass = await pet.locator('section').getAttribute('class');
    assert.match(stageClass, /presentationStage/, 'native event enters presentation mode');
    assert.match(stageClass, new RegExp(`priority${expectedPriority}`), 'priority-specific presentation is retained');
    const board = placard().getByText(reminder.title, { exact: true }).locator('..');
    // Wait for the real entrance animation rather than disabling all motion.
    await pet.waitForFunction(() => {
      const board = document.querySelector('[class*="signBoard"]');
      const hint = document.querySelector('[class*="autoReturnHint"]');
      return [board, hint].every((element) => element && getComputedStyle(element).opacity === '1'
        && element.getAnimations().every((animation) => animation.playState === 'finished'));
    });
    const viewport = pet.viewportSize();
    for (const element of [board, placard().getByRole('button', { name: '完成啦', exact: true }), placard().getByRole('button', { name: '5 分钟后', exact: true })]) {
      const box = await element.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
        'placard text and actions stay inside the native-sized presentation surface');
    }
    assert.equal(await pet.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth), false,
      'presentation has no document scrollbar');
    const before = (await requests(pet, 'window.drag.start')).length;
    await character().dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    await character().dispatchEvent('pointermove', { pointerId: 1, clientX: 80, clientY: 80 });
    await character().dispatchEvent('pointerup', { pointerId: 1, clientX: 80, clientY: 80 });
    assert.equal((await requests(pet, 'window.drag.start')).length, before, 'presentation cannot start a normal pet drag');
    assert.equal(await pet.getByRole('dialog').count(), 0, 'reminder presentation is not replaced by the interaction menu');
  }

  try {
    await pet.setViewportSize({ width: 500, height: 540 });
    await pet.goto(modeUrl('pet'));
    await character().waitFor();
    await dashboard.goto(modeUrl('dashboard'));
    const testButton = dashboard.getByRole('button', { name: '10 秒后测试提醒', exact: true });
    await testButton.waitFor();
    await testButton.click();
    const creation = await requests(dashboard, 'reminder.create');
    assert.equal(creation.length, 1, 'one test click submits one reminder');
    const { payload, receivedAt } = creation[0];
    assert.equal(payload.title, '站起来活动一下');
    assert.equal(payload.repeatRule, 'none');
    assert.equal(payload.priority, 'urgent');
    assert.ok(payload.dueAt - receivedAt >= 9900 && payload.dueAt - receivedAt <= 10000, 'test schedules ten seconds, not ten minutes');
    const first = { ...payload, id: 81001, completed: false, notified: false };
    await sync(dashboard, { reminders: [first] });
    await sync(pet, { reminders: [first] });
    assert.equal(await placard().count(), 0, 'future reminder is not displayed early');
    assert.equal(await dashboard.getByRole('button', { name: /工具首页/ }).isVisible(), true, 'dashboard remains open during test');
    await pet.waitForFunction((dueAt) => Date.now() >= dueAt, payload.dueAt, { timeout: 15000 });
    await emit(pet, 'reminder.triggered', { ...first, notified: true });
    assert.ok(Date.now() >= first.dueAt, 'synthetic host event is not injected before the real countdown elapses');
    await checkPlacard(first, 'Urgent');
    assert.match(await character().locator(':scope > div').first().evaluate((element) => getComputedStyle(element).backgroundImage), /data:image\/svg\+xml/,
      'single-image test character is used, never personal artwork');
    await sync(pet, { reminders: [{ ...first, notified: true }] });
    await placard().waitFor();
    await pet.screenshot({ path: path.join(output, 'urgent-single-placard.png') });

    await emit(pet, 'presentation.ended');
    await placard().waitFor({ state: 'hidden' });
    await pet.setViewportSize({ width: 320, height: 440 });
    await pet.getByText('提醒时间到', { exact: true }).waitFor();
    await pet.getByRole('button', { name: '完成', exact: true }).click();
    await pet.getByText('提醒时间到', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual((await requests(pet, 'reminder.complete')).map((item) => item.payload), [{ id: first.id }],
      'returning from center keeps exact-target completion available in the normal bubble');
    await pet.getByText('太棒啦！', { exact: true }).waitFor({ state: 'hidden' });

    // Missing selection falls back to the first available public sprite sheet.
    await pet.evaluate(() => { const f = window.__reminderFixture; f.sync({ characters: [f.builtin], activeCharacterId: 'missing-selection', reminders: [] }); });
    await pet.setViewportSize({ width: 460, height: 500 });
    const second = { ...first, id: 81002, title: '公开小鼠举牌回归', priority: 'normal', repeatRule: 'daily', notified: true };
    await sync(pet, { reminders: [second] });
    await emit(pet, 'reminder.triggered', second);
    await checkPlacard(second, 'Normal');
    assert.match(await placard().innerText(), /测试依依的重复提醒/);
    const sprite = character().locator(':scope > div').first();
    assert.match(await sprite.evaluate((element) => getComputedStyle(element).backgroundImage), /\/assets\/milo-sprite\.png/);
    assert.equal(await sprite.evaluate((element) => getComputedStyle(element).backgroundSize), '400% 200%', 'public sheet retains sprite-frame layout');
    await pet.screenshot({ path: path.join(output, 'normal-public-sheet-placard.png') });
    await placard().getByRole('button', { name: '完成啦', exact: true }).click();
    await placard().waitFor({ state: 'hidden' });
    assert.deepEqual((await requests(pet, 'reminder.complete')).map((item) => item.payload), [{ id: first.id }, { id: second.id }], 'center action completes its own reminder once');

    await pet.evaluate(() => { const f = window.__reminderFixture; f.sync({ characters: [f.builtin, f.single], activeCharacterId: f.single.id }); });
    await pet.setViewportSize({ width: 480, height: 520 });
    const third = { ...first, id: 81003, title: '五分钟后再次提醒', priority: 'important', notified: true };
    await sync(pet, { reminders: [third] });
    await emit(pet, 'reminder.triggered', third);
    await checkPlacard(third, 'Important');
    const snoozeStart = Date.now();
    await placard().getByRole('button', { name: '5 分钟后', exact: true }).click();
    await placard().waitFor({ state: 'hidden' });
    await pet.waitForFunction(() => window.__reminderFixture.events.some((item) => item.type === 'reminder.dismissed'));
    assert.deepEqual((await requests(pet, 'reminder.snooze')).map((item) => item.payload), [{ id: third.id, minutes: 5 }]);
    assert.equal(await pet.getByRole('button', { name: '完成', exact: true }).count(), 0, 'native dismissal clears the returned bubble');
    const postponed = await pet.evaluate(() => window.__reminderFixture.app.reminders[0]);
    assert.ok(postponed.dueAt >= snoozeStart + 300000 && postponed.notified === false, 'synthetic host stores five-minute postponement');

    // A wholly empty wardrobe must still use the public built-in character.
    await sync(pet, { characters: [], activeCharacterId: 'missing-selection' });
    assert.match(await character().locator(':scope > div').first().evaluate((element) => getComputedStyle(element).backgroundImage), /\/assets\/milo-sprite\.png/);
    assert.equal(await character().getAttribute('tabindex'), '0', 'ordinary pet interaction is restored after dismissal');
    assert.deepEqual(nativeDialogs, [], 'no browser-native confirmation dialogs');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS reminder UI: real 10-second creation interval with dashboard open; synthetic host presentation, 3 priorities/native-sized surfaces, single image/public sheet fallbacks, exact-target center/bubble completion, presentation.ended and 5-minute snooze. Windows placement/timers and real installation are outside this test.');
  } catch (error) {
    await pet.screenshot({ path: path.join(output, 'failure-pet.png') }).catch(() => {});
    await dashboard.screenshot({ path: path.join(output, 'failure-dashboard.png') }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
