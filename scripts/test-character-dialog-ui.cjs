/** Isolated character confirmation regression. Only synthetic host state is changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const character = { id: 'synthetic-upload', name: '测试衣柜角色', imageUrl: '/assets/milo-sprite.png', layout: 'sheet', builtIn: false };
    const app = { reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: false,
      autoHideEnabled: true, autoHideMinutes: 10, characters: [
        { id: 'builtin', name: '经典小鼠', imageUrl: '/assets/milo-sprite.png', layout: 'sheet', builtIn: true }, character,
      ], activeCharacterId: 'synthetic-upload', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
      lastDashboardView: 'settings', lastToolCategory: '' };
    const fixture = window.__characterFixture = { app, character, calls: [], emit: null };
    fixture.emit = (patch = {}) => { Object.assign(app, patch); listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { ...app, now: Date.now() } } })); };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        fixture.calls.push(request);
        if (request.type === 'app.ready') setTimeout(() => fixture.emit(), 20);
        if (request.type === 'character.delete') setTimeout(() => fixture.emit({ characters: app.characters.filter((item) => item.id !== request.payload.id), activeCharacterId: 'builtin' }), 80);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], nativeDialogs = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  const output = path.resolve(__dirname, '../artifacts/confirmation-dialogs'); fs.mkdirSync(output, { recursive: true });
  const modal = () => page.getByRole('dialog', { name: '删除衣柜角色？', exact: true });
  const remove = () => page.getByRole('article').filter({ has: page.getByText('测试衣柜角色', { exact: true }) }).getByRole('button', { name: '删除', exact: true });
  const requests = () => page.evaluate(() => window.__characterFixture.calls.filter((request) => request.type === 'character.delete'));
  const open = async () => { await remove().click(); await modal().waitFor(); };
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await page.getByRole('heading', { name: '角色衣柜', exact: true }).waitFor();
    assert.equal(await page.getByRole('article').filter({ has: page.getByText('经典小鼠', { exact: true }) }).getByRole('button', { name: '删除', exact: true }).count(), 0, 'built-in character has no delete action');
    for (const [width, height, textSize, theme] of [[1280, 762, 'comfortable', 'warm'], [1280, 762, 'large', 'cloud'], [760, 600, 'large', 'rose']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ textSize, theme }) => window.__characterFixture.emit({ workspaceTextSize: textSize, workspaceTheme: theme }), { textSize, theme });
      await open();
      const box = await modal().boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2 && Math.abs(box.y + box.height / 2 - height / 2) < 2, 'dialog centered in whole client');
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, 'dialog stays in viewport');
      assert.equal(await modal().getByRole('button', { name: '取消', exact: true }).evaluate((element) => element === document.activeElement), true, 'cancel is default');
      for (let n = 0; n < 7; n++) { await page.keyboard.press(n % 2 ? 'Shift+Tab' : 'Tab'); assert.equal(await modal().evaluate((element) => element.contains(document.activeElement)), true, 'keyboard focus stays in modal'); }
      assert.equal(await modal().evaluate((element) => element.parentElement === document.body), true, 'shared portal is outside content transforms');
      await page.screenshot({ path: path.join(output, `character-${width}-${textSize}.png`) });
      await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
      assert.equal(await remove().evaluate((element) => element === document.activeElement), true, 'focus returns to delete action');
      assert.equal((await requests()).length, 0, 'cancel does not delete');
    }
    await open();
    await page.evaluate(() => { const f = window.__characterFixture; f.emit({ characters: f.app.characters.map((item) => item.id === f.character.id ? { ...item, name: '原生层已改名' } : item) }); });
    assert.match(await modal().innerText(), /测试衣柜角色/, 'the reviewed name is frozen');
    await modal().getByRole('button', { name: '确认删除', exact: true }).click(); await modal().waitFor({ state: 'hidden' });
    assert.equal((await requests()).length, 0, 'changed native identity is not deleted under old confirmation');
    await page.evaluate(() => { const f = window.__characterFixture; f.emit({ characters: [f.app.characters[0], f.character] }); });
    await open();
    await modal().getByRole('button', { name: '确认删除', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await modal().waitFor({ state: 'hidden' });
    await remove().waitFor({ state: 'hidden' });
    assert.deepEqual((await requests()).map((request) => request.payload), [{ id: 'synthetic-upload' }], 'double activation sends one exact target');
    assert.deepEqual(nativeDialogs, []); assert.deepEqual(errors, []);
    console.log('PASS character confirmation: shared client-centered modal, both font sizes, 3 themes, keyboard/cancel focus, cancel zero requests, native identity recheck and duplicate guard. Synthetic host only.');
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
