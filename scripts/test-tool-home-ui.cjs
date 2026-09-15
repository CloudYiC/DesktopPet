/** Compact tool-home regression. Runs in an isolated browser profile only;
 * no native host, real reminders, devices, files or user settings are changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/tool-home');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    const sidebar = page.getByRole('complementary').first();
    const main = page.getByRole('main').last();
    await sidebar.getByRole('button', { name: /^工具首页/ }).click();
    const search = main.getByPlaceholder('搜索工具…', { exact: true });
    await search.waitFor();
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1040 }, { width: 1024, height: 640 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const textSize of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, textSize);
        await main.evaluate((element) => { element.scrollTop = 0; });
        const label = `${viewport.width}x${viewport.height}/${textSize}`;
        const brand = sidebar.locator(':scope > div').first();
        assert.equal((await brand.innerText()).replace(/\s+/g, ''), '依云依助手', `${label}: brand has only the logo and app name`);
        assert.equal(await main.getByText('CLOUDYI TOOLBOX · LOCAL FIRST', { exact: true }).count(), 0, `${label}: introductory banner is removed`);
        assert.equal(await main.getByText('常用开发工具，现在和可爱依依住在一起。', { exact: true }).count(), 0);
        assert.equal(await main.getByText('个工具可直接使用', { exact: true }).count(), 0, `${label}: hero statistic is removed`);
        const geometry = await main.evaluate((area) => {
          const box = area.getBoundingClientRect();
          const first = area.querySelector('section > div');
          const firstBox = first.getBoundingClientRect();
          const brand = document.querySelector('aside > div');
          const mark = brand.firstElementChild.getBoundingClientRect();
          const name = brand.querySelector('strong').getBoundingClientRect();
          return { topGap: firstBox.top - box.top, leftGap: firstBox.left - box.left,
            contentWidth: area.clientWidth, scrollWidth: area.scrollWidth,
            firstText: first.innerText, categories: first.querySelectorAll('button').length,
            brandCenterDelta: Math.abs((mark.top + mark.bottom) / 2 - (name.top + name.bottom) / 2) };
        });
        assert.equal(geometry.categories, 4, `${label}: all category cards are the first content`);
        assert.match(geometry.firstText, /数据处理/);
        assert.ok(geometry.topGap >= 10 && geometry.topGap <= 20, `${label}: no empty hero gap remains (${geometry.topGap}px)`);
        assert.ok(geometry.leftGap >= 12 && geometry.leftGap <= 20, `${label}: standard content inset remains`);
        assert.ok(geometry.scrollWidth <= geometry.contentWidth + 1, `${label}: no page-wide horizontal overflow`);
        assert.ok(geometry.brandCenterDelta <= 1, `${label}: app title stays centered with its logo`);
        assert.equal(await main.getByRole('article').count(), 20, `${label}: every built-in tool remains available`);
        await page.screenshot({ path: path.join(output, `${label.replace('/', '-')}.png`), animations: 'disabled' });
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.keyboard.press('Control+k');
    assert.equal(await search.evaluate((element) => element === document.activeElement), true, 'search shortcut remains available');
    await search.fill('JSON');
    assert.equal(await main.getByRole('article').count(), 1);
    await main.getByRole('button', { name: '打开', exact: true }).click();
    await page.getByRole('heading', { name: 'JSON 格式化', exact: true }).waitFor();
    await page.getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await search.fill('');
    await main.getByRole('button', { name: /网络与协议/ }).click();
    assert.equal(await main.getByRole('article').count(), 6, 'category navigation still filters the catalog');
    await sidebar.getByRole('button', { name: /^工具首页/ }).click();
    assert.equal(await main.getByRole('article').count(), 20, 'home navigation restores every tool');
    assert.equal(await sidebar.getByRole('button', { name: '10 秒后测试提醒', exact: true }).count(), 1, 'test-reminder entry is preserved, without triggering it');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS: compact home and centered brand at four client sizes/two text sizes; categories, search, direct-open and reminder entry preserved.');
    console.log(`Screenshots: ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
