/** Browser regression for the shared packet workbench. Start frontend Vite first.
 * Provide Playwright on NODE_PATH, and optionally PACKET_TEST_BROWSER for Edge.
 * Tests use an isolated browser context and synthetic bytes, never real captures.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/packet-workbench');
  const ui = (role, name) => page.getByRole(role, { name, exact: true });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await ui('button', '◎ 网络协议').click();
    await page.getByRole('article').filter({ hasText: '十六进制报文分析器' }).getByRole('button', { name: 'Open', exact: true }).click();
    const selected = ui('region', '当前选区');
    await ui('button', '源端口').waitFor();
    assert.match(await selected.innerText(), /24576[\s\S]*96/);
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await ui('button', 'UDP 长度').click();
    assert.match(await selected.innerText(), /0x0026 \/ 38/);
    await ui('button', '0x002A: 01').click();
    await ui('button', '0x002D: 10').click({ modifiers: ['Shift'] });
    assert.match(await selected.innerText(), /4 字节/);
    await ui('button', '将选区定义为字段').click();
    await ui('textbox', '字段名称').fill('测试消息头');
    await ui('button', '保存字段').click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /测试消息头/);
    await page.reload();
    await ui('button', '◎ 网络协议').click();
    await page.getByRole('article').filter({ hasText: '十六进制报文分析器' }).getByRole('button', { name: 'Open', exact: true }).click();
    await ui('tab', '自定义字段 (1)').click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /测试消息头/);
    await ui('textbox', '十六进制报文').fill('ff 00 00 01');
    await ui('combobox', '解析起点').selectOption('raw');
    assert.match(await page.innerText('body'), /待重新分析/);
    await page.getByRole('button', { name: /^分析报文/ }).click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /超出当前报文/);
    await ui('button', '编辑').click();
    await ui('textbox', '字段起始偏移').fill('0');
    await ui('button', '保存字段').click();
    assert.match(await selected.innerText(), /0x0000 \/ 0/);
    await ui('button', '清空').click();
    assert.match(await page.innerText('body'), /粘贴报文后开始分析/);
    assert.match(await ui('tab', '自定义字段 (1)').innerText(), /1/);

    const large = new Array(65536).fill('ab').join(' ');
    await ui('textbox', '十六进制报文').fill(large);
    await ui('textbox', '十六进制报文').press('Control+Enter');
    await ui('combobox', '每行字节数').selectOption('32');
    await ui('textbox', '定位偏移').fill('65535');
    await ui('button', '跳转到偏移').click();
    await ui('button', '0xFFFF: AB').waitFor();
    await ui('combobox', '每行字节数').selectOption('8');
    await ui('button', '0xFFFF: AB').waitFor();
    const byteBox = await ui('button', '0xFFFF: AB').boundingBox();
    const regionBox = await ui('region', '报文字节视图').boundingBox();
    assert.ok(byteBox.y >= regionBox.y && byteBox.y + byteBox.height <= regionBox.y + regionBox.height, 'Last byte remains inside pane after row-width change');
    assert.ok(await ui('region', '报文字节视图').getByRole('button').count() < 400, 'Rows are virtualized');
    const heightBefore = regionBox.height;
    await ui('textbox', '定位偏移').fill('0x10000');
    await ui('button', '跳转到偏移').click();
    assert.match(await page.getByRole('alert').innerText(), /65535/);
    assert.ok((await ui('region', '报文字节视图').boundingBox()).height > heightBefore / 2, 'Validation error preserves scroll area');
    await ui('button', '载入示例').click();
    await page.getByRole('button', { name: /^分析报文/ }).click();
    await ui('combobox', '每行字节数').selectOption('16');
    await ui('tab', '标准字段').click();
    await ui('button', '收起 ⌃').click();
    assert.equal(await ui('textbox', '十六进制报文').isVisible(), false);
    await ui('button', '展开 ⌄').click();
    for (const width of [1280, 1100, 920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(output, `desktop-${width}.png`), fullPage: true });
      const workspace = await ui('region', '十六进制报文分析器').boundingBox();
      assert.ok(workspace.x + workspace.width <= width + 1, `Workspace fits ${width}px`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: sample, linked selections, custom persistence/edit, dirty state, clear, 64 KiB virtualization, row widths, offset validation, collapse, responsive widths.');
    console.log(`Screenshots: ${output}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
