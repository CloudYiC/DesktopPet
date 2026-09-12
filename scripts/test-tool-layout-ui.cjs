/** Verify compact tool navigation in an isolated preview profile; no native mutations. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const nativeSource = fs.readFileSync(path.resolve(__dirname, '../native/src/WebViewWindow.cpp'), 'utf8');
  assert.match(nativeSource, /kDashboardPreferredWidth = 1280;/);
  assert.match(nativeSource, /kDashboardPreferredHeight = 800;/);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/tool-layout');
  const header = () => page.locator('header[aria-label="工具详情导航"]');
  const sidebar = () => page.getByRole('complementary').first();
  const toolHome = () => page.getByRole('button', { name: /^⌂ 工具首页/ }).click();
  const openTool = async (name) => {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const enable = card.getByRole('button', { name: 'Enable', exact: true });
    if (await enable.count()) await enable.click();
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await header().waitFor();
  };
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await toolHome();
    const cards = await page.getByRole('article').filter({ has: page.getByRole('button', { name: /^(Open|Enable)$/ }) }).evaluateAll((elements) =>
      elements.map((element) => ({ name: element.querySelector('h3').textContent, description: element.querySelector('p').textContent })));
    assert.equal(cards.length, 17);
    assert.equal(Math.round((await sidebar().boundingBox()).width), 192);
    for (const { name, description } of cards) {
      await openTool(name);
      assert.equal(await header().count(), 1, `${name} has a single navigation row`);
      const title = await header().getByRole('heading', { name, exact: true }).boundingBox();
      const back = await header().getByRole('button', { name: '← 返回工具列表', exact: true }).boundingBox();
      const frame = await header().boundingBox();
      assert.ok(title.x > back.x + back.width && Math.abs(title.y - back.y) < 8, `${name} title shares the back-navigation row`);
      assert.equal(Math.round(frame.y), 12, `${name} top inset is compact`);
      assert.equal(Math.round(frame.x - (await sidebar().boundingBox()).width), 16, `${name} content gap is compact`);
      assert.equal(await header().locator('p,em,i').count(), 0, `${name} has no repeated introduction or large icon`);
      assert.equal((await page.getByRole('main').last().innerText()).includes(description), false, `${name} description remains catalog-only`);
      if (['JSON 格式化', '网络调试助手', '十六进制报文分析器'].includes(name)) {
        await page.screenshot({ path: path.join(output, `${name}-1280.png`), fullPage: true });
      }
      await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      assert.ok(await page.getByRole('article').filter({ hasText: description }).count(), `${name} description is still in catalog`);
    }
    for (const width of [1024, 920, 760]) {
      await page.setViewportSize({ width, height: 800 });
      for (const name of ['JSON 格式化', '网络调试助手', '十六进制报文分析器']) {
        await openTool(name);
        const frame = await header().boundingBox();
        assert.ok(frame.x + frame.width <= width, `${name} header fits ${width}px`);
        await page.screenshot({ path: path.join(output, `${name}-${width}.png`), fullPage: true });
        await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: /^⌁ 今天/ }).click();
    assert.equal(await header().count(), 0, 'Pet pages keep their existing heading');
    const petPadding = await page.getByRole('main').last().evaluate((element) => getComputedStyle(element).padding);
    assert.equal(petPadding, '12px 16px 16px', 'Pet pages use the same compact content insets as tools');
    const petHeader = await page.getByRole('main').last().locator(':scope > header').boundingBox();
    assert.equal(Math.round(petHeader.y), 12, 'Pet header shares the 12px top inset');
    assert.equal(Math.round(petHeader.x - (await sidebar().boundingBox()).width), 16, 'Pet header shares the 16px sidebar gap');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${cards.length} tool headers, catalog descriptions, 192px sidebar, unified 12/16px insets, 3 responsive widths, unchanged native window and retained pet headings.`);
    console.log(`Screenshots: ${output}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
