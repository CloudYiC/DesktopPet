/** Non-layout acknowledgements and local persistent failures. Isolated browser only;
 * clipboard and storage failures are fixtures, never real user data or devices. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await context.addInitScript(() => {
    window.__feedbackFixture = { clipboard: [], failCopy: false, failPaste: false, failStorage: false };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { if (window.__feedbackFixture.failCopy) throw new Error('Synthetic clipboard denied'); window.__feedbackFixture.clipboard.push(text); },
      readText: async () => { if (window.__feedbackFixture.failPaste) throw new Error('Synthetic clipboard denied'); return 'ab cd'; },
    } });
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (window.__feedbackFixture.failStorage && key === 'cloudyi.packet-inspector.custom-fields.v1') throw new Error('Synthetic storage denied');
      return originalSetItem.call(this, key, value);
    };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/action-feedback'); fs.mkdirSync(output, { recursive: true });
  const toast = () => page.getByTestId('action-toast');
  const selection = () => page.getByRole('region', { name: '当前选区', exact: true });
  const input = () => page.getByRole('region', { name: '报文输入', exact: true });
  const copy = () => page.getByRole('button', { name: '复制选中字节', exact: true });
  async function open() {
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '网络协议', exact: true }).click();
    await page.getByRole('article').filter({ hasText: '十六进制报文分析器' }).getByRole('button', { name: '打开', exact: true }).click();
    await copy().waitFor();
  }
  async function geometry() {
    return input().evaluate((element) => {
      const main = element.closest('main');
      const inputRect = element.getBoundingClientRect();
      const gridRect = main.querySelector('[data-testid="packet-inspector-grid"]').getBoundingClientRect();
      return { inputHeight: inputRect.height, gridTop: gridRect.top, pageScrollHeight: main.scrollHeight, pageTop: main.scrollTop };
    });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard'); await open();
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1008, height: 610 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const size of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, size);
        await copy().scrollIntoViewIfNeeded();
        const before = await geometry();
        await copy().click(); await toast().waitFor();
        assert.deepEqual(await geometry(), before, 'Copy acknowledgement never changes input, results or outer scroll geometry');
        assert.equal(await input().getByText(/已复制/).count(), 0, 'Copy success never appears in the input card');
        const popup = await toast().evaluate((element) => ({ position: getComputedStyle(element.parentElement).position, rect: element.getBoundingClientRect().toJSON(), width: innerWidth }));
        assert.equal(popup.position, 'fixed', 'Toast is outside layout flow');
        assert.ok(popup.rect.x >= 0 && popup.rect.right <= popup.width, 'Toast stays inside client width');
        await page.screenshot({ path: path.join(output, `${viewport.width}-${size}-copy.png`) });
        await toast().getByRole('button', { name: '关闭操作提示' }).click();
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await copy().click();
    await page.waitForTimeout(2500);
    await copy().click();
    await page.waitForTimeout(1900);
    assert.ok(await toast().isVisible(), 'Repeated identical success restarts dismissal time');
    await toast().waitFor({ state: 'hidden', timeout: 5000 });
    await copy().click(); await toast().hover();
    await page.waitForTimeout(4200);
    assert.ok(await toast().isVisible(), 'Hover pauses dismissal for reading');
    await page.mouse.move(5, 5); await toast().waitFor({ state: 'hidden', timeout: 5000 });
    await copy().focus(); await page.keyboard.press('Enter');
    assert.equal(await copy().evaluate((element) => document.activeElement === element), true, 'Notification never steals keyboard focus');
    await toast().getByRole('button', { name: '关闭操作提示' }).click();

    await page.evaluate(() => { window.__feedbackFixture.failCopy = true; });
    await copy().click();
    assert.match(await selection().getByRole('alert').innerText(), /复制失败/);
    assert.equal(await toast().count(), 0, 'Copy failure stays local, not an auto-hiding success');
    await page.waitForTimeout(4200);
    assert.ok(await selection().getByRole('alert').isVisible(), 'Action error remains available after toast duration');
    await page.evaluate(() => { window.__feedbackFixture.failCopy = false; });
    await copy().click(); assert.equal(await selection().getByRole('alert').count(), 0, 'Successful retry clears only related error');
    await toast().getByRole('button', { name: '关闭操作提示' }).click();

    await page.getByRole('button', { name: '将选区定义为字段', exact: true }).click();
    await page.getByRole('button', { name: '保存字段', exact: true }).click();
    assert.match(await page.getByTestId('packet-field-panel').getByRole('alert').innerText(), /字段名称/);
    await page.getByRole('textbox', { name: '字段名称', exact: true }).fill('提示回归字段');
    await page.evaluate(() => { window.__feedbackFixture.failStorage = true; });
    await page.getByRole('button', { name: '保存字段', exact: true }).click();
    assert.match(await page.getByTestId('packet-field-panel').getByRole('alert').innerText(), /未保存到本机/);
    assert.equal(await input().getByText(/未保存到本机/).count(), 0, 'Storage failure belongs to fields, not top input');
    assert.equal(await toast().count(), 0, 'Storage failure does not claim success');
    await page.evaluate(() => { window.__feedbackFixture.failStorage = false; });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '保存字段', exact: true }).click();
    assert.equal(await page.getByTestId('packet-field-panel').getByRole('alert').count(), 0);
    assert.match(await toast().innerText(), /已保存到本机/);
    await toast().getByRole('button', { name: '关闭操作提示' }).click();
    await page.evaluate(() => { window.__feedbackFixture.failPaste = true; });
    await page.getByRole('button', { name: '粘贴', exact: true }).click();
    assert.match(await input().getByRole('alert').innerText(), /Ctrl\+V/);
    assert.equal(await toast().count(), 0, 'Paste recovery instruction remains next to input');
    await page.screenshot({ path: path.join(output, 'local-errors.png') });
    await page.getByRole('textbox', { name: '十六进制报文', exact: true }).fill('00 01');
    assert.equal(await input().getByRole('alert').count(), 0, 'Manual paste clears clipboard guidance');
    await copy().click();
    await page.locator('header[aria-label="工具详情导航"]').getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    assert.equal(await toast().count(), 0, 'Unmount removes notification and timer');
    assert.deepEqual(errors, []);
    console.log('PASS action feedback: six responsive/font configurations, zero notification layout shift, repeat/reset, hover pause, no focus theft, local persistent copy/storage/paste errors and unmount cleanup.');
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
