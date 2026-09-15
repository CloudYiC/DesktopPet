/**
 * Isolated browser checks for the desktop pet shortcut menu and shared center.
 * Uses only the public sprite or a synthetic character. Native monitor/window
 * movement and browser launching are not simulated as successful OS actions.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const syntheticImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="210" height="210"><rect x="36" y="5" width="138" height="198" rx="58" fill="#168b85"/><circle cx="79" cy="77" r="10" fill="white"/><circle cx="131" cy="77" r="10" fill="white"/><path d="M76 116Q105 145 134 116" fill="none" stroke="white" stroke-width="7"/></svg>')}`;
const privateCharacter = process.env.PET_TEST_CHARACTER;
const singleImage = privateCharacter ? `data:image/png;base64,${fs.readFileSync(privateCharacter).toString('base64')}` : syntheticImage;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const errors = [];
  // Optional local-only visual audit: private images never become test assets.
  const output = path.resolve(__dirname, privateCharacter ? '../artifacts/pet-shortcuts-private' : '../artifacts/pet-shortcuts');
  fs.mkdirSync(output, { recursive: true });
  let cases = 0;
  for (const layout of (privateCharacter ? ['single'] : ['single', 'sheet'])) {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 320, height: 620 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
      await context.addInitScript(({ layout, syntheticImage }) => {
        const listeners = new Set();
        const app = { reminders: [], now: Date.now(), petName: '测试依依', soundEnabled: false, speechEnabled: false,
          financeWebsiteUrl: '', learningWebsiteUrl: '',
          characters: [{ id: 'test', name: '测试角色', imageUrl: layout === 'single' ? syntheticImage : '/assets/milo-sprite.png', layout, builtIn: layout === 'sheet' }],
          activeCharacterId: 'test', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true,
          lastDashboardView: 'toolbox', lastToolCategory: '' };
        const fixture = window.__petFixture = { calls: [], app, emit: null };
        fixture.emit = (type, payload) => listeners.forEach((listener) => listener({ data: { type, payload } }));
        if (!window.chrome) window.chrome = {};
        window.chrome.webview = {
          addEventListener: (_type, listener) => listeners.add(listener),
          removeEventListener: (_type, listener) => listeners.delete(listener),
          postMessage: (message) => {
            fixture.calls.push(message);
            if (message.type === 'app.ready') setTimeout(() => fixture.emit('state.sync', app), 10);
          },
        };
      }, { layout, syntheticImage: singleImage });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      const target = new URL(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/');
      target.search = '?mode=pet';
      await page.goto(target.href);
      const pet = page.getByRole('button', { name: '点击测试依依打开快捷入口，拖动可移动位置', exact: true });
      await pet.waitFor();
      const menu = page.getByRole('dialog', { name: '依依快捷入口', exact: true });
      const calls = (type) => page.evaluate((type) => window.__petFixture.calls.filter((item) => item.type === type), type);
      const emit = async (type, payload) => {
        await page.evaluate(({ type, payload }) => window.__petFixture.emit(type, payload), { type, payload });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };

      // The character and frame must share the same CSS center at every DPI.
      const box = await pet.boundingBox();
      await page.mouse.move(box.x + box.width / 2, Math.min(600, box.y + box.height / 2));
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 16, Math.min(600, box.y + box.height / 2));
      const frame = page.locator('[class*="dragFrame_"]');
      await frame.waitFor();
      const dragBox = await pet.boundingBox();
      const frameBox = await frame.boundingBox();
      assert.ok(Math.abs((dragBox.x + dragBox.width / 2) - (frameBox.x + frameBox.width / 2)) < 0.25, `${layout}/${scale}: centered drag frame`);
      assert.equal(await pet.evaluate((element) => getComputedStyle(element).animationName), 'none', 'dragging pauses motion');
      assert.equal(await pet.locator('> div').first().evaluate((element) => getComputedStyle(element).animationName), 'none', 'dragging pauses sprite animation');
      await page.screenshot({ path: path.join(output, `${layout}-${scale}-drag.png`) });
      await page.mouse.up();
      assert.ok((await calls('window.drag.start')).length > 0);
      assert.ok((await calls('window.drag.end')).length > 0);
      assert.equal(await menu.count(), 0, 'drag release does not also open shortcuts');

      // Also reproduce the legacy 320-physical-pixel host at scaled DPI. This
      // catches a fixed-right offset even if the new host uses logical sizing.
      await page.setViewportSize({ width: Math.round(320 / scale), height: 620 });
      const narrowBox = await pet.boundingBox();
      await page.mouse.move(narrowBox.x + narrowBox.width / 2, narrowBox.y + narrowBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(narrowBox.x + narrowBox.width / 2 + 16, narrowBox.y + narrowBox.height / 2);
      await frame.waitFor();
      const narrowPet = await pet.boundingBox();
      const narrowFrame = await frame.boundingBox();
      assert.ok(Math.abs((narrowPet.x + narrowPet.width / 2) - (narrowFrame.x + narrowFrame.width / 2)) < 0.25, 'center survives a narrower CSS viewport');
      await page.mouse.up();
      await page.setViewportSize({ width: 320, height: 620 });

      await pet.press('Enter');
      await menu.waitFor();
      assert.deepEqual(await menu.getByRole('button').allTextContents(), ['', '打开工具台›', '我的理财', '个人学习']);
      assert.equal(await page.getByText('和我互动', { exact: true }).count(), 0);
      assert.ok((await calls('window.petMenu')).some((item) => item.payload.open && item.payload.layout === layout));
      let menuBox = await menu.boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 320 && menuBox.y + menuBox.height <= 620, 'menu stays in expanded viewport');
      assert.ok(menuBox.y + menuBox.height <= (await pet.boundingBox()).y, 'normal menu does not cover the head');
      await page.screenshot({ path: path.join(output, `${layout}-${scale}-menu.png`) });

      if (layout === 'single' && scale === 1) {
        await page.waitForTimeout(9_000);
        assert.equal(await menu.isVisible(), true, 'shortcut menu has no automatic dismiss timer');
        await menu.getByRole('button', { name: '我的理财', exact: true }).click();
        assert.equal((await calls('shortcuts.open')).at(-1).payload.shortcut, 'finance');
        await pet.press('Enter');
        await menu.getByRole('button', { name: '个人学习', exact: true }).click();
        assert.equal((await calls('shortcuts.open')).at(-1).payload.shortcut, 'learning');
        await pet.press('Enter');
        await menu.getByRole('button', { name: '打开工具台', exact: false }).click();
        assert.equal((await calls('window.openToolbox')).length, 1);
        await pet.press('Enter');
        await menu.getByRole('button', { name: '网站快捷入口设置', exact: true }).click();
        assert.equal((await calls('window.openShortcutSettings')).length, 1);
        await pet.press('Enter');
        await menu.getByRole('button', { name: '个人学习', exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await menu.getByRole('button', { name: '网站快捷入口设置', exact: true }).evaluate((element) => document.activeElement === element), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await menu.getByRole('button', { name: '个人学习', exact: true }).evaluate((element) => document.activeElement === element), true);
      }
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(), 0);
      assert.equal(await pet.getAttribute('aria-expanded'), 'false');
      assert.equal(await pet.evaluate((element) => document.activeElement === element), true, 'Escape restores focus to pet');

      await pet.press('Enter');
      await emit('pet.menu.layout', { open: true, placement: 'below', anchorY: 2 });
      menuBox = await menu.boundingBox();
      assert.ok(menuBox.y >= 2 + (layout === 'single' ? 210 : 340), 'top-edge menu unfolds below pet');
      assert.ok(menuBox.y + menuBox.height <= 620, 'below menu fits');
      assert.ok(Math.abs((await pet.boundingBox()).y - 2) < 0.25, 'host anchor is preserved');
      await page.screenshot({ path: path.join(output, `${layout}-${scale}-below.png`) });

      await page.setViewportSize({ width: 320, height: 490 });
      await emit('pet.menu.layout', { open: true, placement: 'above', anchorY: 120 });
      menuBox = await menu.boundingBox();
      assert.ok(menuBox.y >= 8 && menuBox.y + menuBox.height <= 482, 'short display clamps menu, not the pet anchor');
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth), false);

      // A short screen can expand horizontally instead of covering the head.
      await page.setViewportSize({ width: 650, height: 490 });
      for (const direction of ['left', 'right']) {
        const anchorX = direction === 'left' ? 350 : 20;
        await emit('pet.menu.layout', { open: true, placement: direction, anchorX, anchorY: 110 });
        menuBox = await menu.boundingBox();
        const characterBox = await pet.boundingBox();
        assert.ok(menuBox.x >= 8 && menuBox.x + menuBox.width <= 642);
        assert.ok(menuBox.y >= 8 && menuBox.y + menuBox.height <= 482);
        assert.ok(direction === 'left' ? menuBox.x + menuBox.width <= characterBox.x - 15 : menuBox.x >= characterBox.x + characterBox.width + 15,
          'side menu leaves the character fully visible');
        assert.ok(Math.abs(characterBox.x - anchorX) < 0.25 && Math.abs(characterBox.y - 110) < 0.25, 'side layout preserves native anchor');
        await page.screenshot({ path: path.join(output, `${layout}-${scale}-${direction}.png`) });
      }
      await page.mouse.click(4, 450);
      assert.equal(await menu.count(), 0, 'blank stage closes menu');

      await pet.press('Enter');
      await emit('pet.menu.layout', { open: false, placement: 'above' });
      assert.equal(await menu.count(), 0, 'native hide/drag can close menu without reopening');
      await page.setViewportSize({ width: 320, height: 620 });
      const beforeReminder = await pet.boundingBox();
      await page.mouse.move(beforeReminder.x + beforeReminder.width / 2, beforeReminder.y + beforeReminder.height / 2);
      await page.mouse.down();
      await page.mouse.move(beforeReminder.x + beforeReminder.width / 2 + 16, beforeReminder.y + beforeReminder.height / 2);
      await frame.waitFor();
      const moveCount = (await calls('window.drag.move')).length;
      const endCount = (await calls('window.drag.end')).length;
      await emit('reminder.triggered', { id: 9981, title: '拖动期间提醒', dueAt: Date.now(),
        completed: false, notified: true, repeatRule: 'none', priority: 'normal' });
      await page.getByRole('alert').waitFor();
      assert.equal(await frame.count(), 0, 'reminder clears stale drag state and frame');
      await page.mouse.move(170, 540); await page.mouse.up();
      assert.equal((await calls('window.drag.move')).length, moveCount, 'held pointer cannot move an active presentation');
      assert.equal((await calls('window.drag.end')).length, endCount, 'old pointer-up cannot save animated reminder coordinates');
      cases += 1;
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(`Pet shortcut UI passed: ${cases} layout/DPI combinations; centered drag, menu bounds, destinations, keyboard and edge layouts. Screenshots: ${output}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
