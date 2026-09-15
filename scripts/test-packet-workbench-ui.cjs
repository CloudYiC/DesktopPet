/** Browser regression for the shared packet workbench. Start frontend Vite first.
 * Provide Playwright on NODE_PATH, and optionally PACKET_TEST_BROWSER for Edge.
 * Tests use an isolated browser context and synthetic bytes, never real captures.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  const openTool = async () => {
    // The preview host emits its persisted startup state asynchronously.
    await page.waitForLoadState('networkidle');
    await ui('button', '网络协议').click();
    await page.getByRole('article').filter({ hasText: '十六进制报文分析器' }).getByRole('button', { name: '打开', exact: true }).click();
    await page.getByTestId('packet-inspector-grid').waitFor();
  };
  const fieldEditorIsFocusedAndVisible = async (label) => {
    await ui('textbox', '字段名称').waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '字段名称');
    const geometry = await ui('textbox', '字段名称').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const fieldScroller = element.closest('[role="tabpanel"]');
      const pane = fieldScroller.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        paneTop: pane.top, paneBottom: pane.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(geometry.top >= Math.max(0, geometry.paneTop) - 1 && geometry.bottom <= Math.min(geometry.viewportHeight, geometry.paneBottom) + 1,
      `${label}: field name is visible within both the client and its local scroller`);
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth + 1, `${label}: field editor stays inside the client width`);
  };
  try {
    fs.mkdirSync(output, { recursive: true });
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await openTool();
    const selected = ui('region', '当前选区');
    await ui('button', '源端口').waitFor();
    assert.match(await selected.innerText(), /24576[\s\S]*96/);
    assert.equal(await ui('combobox', '每行字节数').inputValue(), 'auto', 'Byte layout starts in responsive automatic mode');
    assert.equal(await ui('region', '报文字节视图').evaluate((area) => area.scrollTop), 0, 'Initial automatic sizing keeps the first packet row visible');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await ui('combobox', '当前协议层').selectOption('ipv4');
    await page.getByRole('button', { name: /^版本/ }).click();
    assert.match(await ui('tabpanel', '标准字段').innerText(), /IPv4 \/ 20 字节/, 'Standard fields decode the IPv4 version and IHL bits');
    assert.match(await selected.innerText(), /45[\s\S]*0x000E \/ 14[\s\S]*1 字节[\s\S]*69[\s\S]*69/,
      'Current selection explains the raw 0x45 byte as 69, not the parsed IPv4 version');
    assert.equal(await ui('button', '0x000E: 45').getAttribute('aria-pressed'), 'true', 'Selecting a standard field highlights its source byte');
    await ui('combobox', '当前协议层').selectOption('udp');
    await ui('button', 'UDP 长度').click();
    assert.match(await selected.innerText(), /0x0026 \/ 38/);
    await ui('button', '0x002A: 01').click();
    await ui('button', '0x002D: 10').click({ modifiers: ['Shift'] });
    assert.match(await selected.innerText(), /4 字节/);
    await ui('button', '将选区定义为字段').click();
    await fieldEditorIsFocusedAndVisible('selection definition');
    await ui('textbox', '字段名称').fill('测试消息头');
    await ui('button', '保存字段').click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /测试消息头/);
    await page.reload();
    await openTool();
    await ui('tab', '自定义字段 (1)').click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /测试消息头/);
    await ui('textbox', '十六进制报文').fill('ff 00 00 01');
    await ui('combobox', '解析起点').selectOption('raw');
    assert.match(await page.innerText('body'), /待重新分析/);
    await page.getByRole('button', { name: /^分析报文/ }).click();
    assert.match(await ui('tabpanel', '自定义字段 (1)').innerText(), /超出当前报文/);
    await page.getByTestId('payload-layer-node').getByRole('button', { name: /^定义载荷字段/ }).click();
    await fieldEditorIsFocusedAndVisible('raw protocol definition');
    assert.equal(await ui('textbox', '字段起始偏移').inputValue(), '0', 'Raw protocol definition starts at the first input byte');
    assert.equal(await ui('textbox', '字段长度').inputValue(), '4', 'Raw protocol definition contains the complete raw packet');
    await ui('button', '取消').click();
    await ui('button', '编辑').click();
    await fieldEditorIsFocusedAndVisible('stored field edit');
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
    await ui('combobox', '每行字节数').selectOption('auto');
    const lastByteVisible = () => page.waitForFunction(() => {
      const area = document.querySelector('[aria-label="报文字节视图"]');
      const count = Number(area.style.getPropertyValue('--byte-columns'));
      const last = area.querySelector('[aria-label="0xFFFF: AB"]');
      if (!last || count !== (area.clientWidth < 612 ? 8 : 16)) return false;
      const pane = area.getBoundingClientRect(); const byte = last.getBoundingClientRect();
      return byte.top >= pane.top && byte.bottom <= pane.bottom;
    });
    await lastByteVisible();
    const columnsBeforeHeightChange = await ui('region', '报文字节视图').evaluate((area) => area.style.getPropertyValue('--byte-columns'));
    await page.setViewportSize({ width: 1280, height: 762 });
    await lastByteVisible();
    assert.equal(await ui('region', '报文字节视图').evaluate((area) => area.style.getPropertyValue('--byte-columns')), columnsBeforeHeightChange,
      '1440x960 to 1280x762 preserves the last byte even when automatic columns stay at 16');
    // Size-driven preservation must never fight a user's ordinary local scroll.
    await ui('region', '报文字节视图').evaluate((area) => { area.scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await ui('region', '报文字节视图').evaluate((area) => area.scrollTop), 0,
      'Manual scrolling away from the selected byte is not snapped back by resize handling');
    await ui('textbox', '定位偏移').fill('65535');
    await ui('button', '跳转到偏移').click();
    await lastByteVisible();
    console.log('PASS 64 KiB same-column height reduction and manual scroll freedom.');
    for (const width of [1008, 1920, 760, 1280]) {
      await page.setViewportSize({ width, height: 762 });
      await lastByteVisible();
      assert.match(await selected.innerText(), /0xFFFF \/ 65535[\s\S]*1 字节/, `${width}px: auto resize preserves the 64 KiB end selection`);
      assert.ok(await ui('region', '报文字节视图').getByRole('button').count() < 700, `${width}px: auto resize still virtualizes the packet`);
      console.log(`PASS 64 KiB automatic column resize ${width}px: last byte remains visible.`);
    }
    await ui('button', '载入示例').click();
    await page.getByRole('button', { name: /^分析报文/ }).click();
    await ui('combobox', '每行字节数').selectOption('auto');
    await ui('tab', '标准字段').click();
    await ui('button', '收起 ⌃').click();
    assert.equal(await ui('textbox', '十六进制报文').isVisible(), false);
    await ui('button', '展开 ⌄').click();
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1040 },
      { width: 1100, height: 800 }, { width: 1024, height: 762 }, { width: 1008, height: 610 },
      { width: 960, height: 640 }, { width: 920, height: 762 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const textSize of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, textSize);
        await ui('combobox', '当前协议层').selectOption('udp');
        await ui('button', '源端口').click();
        await ui('combobox', '每行字节数').selectOption('auto');
        await page.getByRole('main').last().evaluate((area) => { area.scrollTop = 0; });
        // Let ResizeObserver apply its 8/16-byte choice before measuring.
        await page.waitForFunction(() => {
          const area = document.querySelector('[aria-label="报文字节视图"]');
          const count = Number(area.style.getPropertyValue('--byte-columns'));
          return count === (area.clientWidth < 612 ? 8 : 16);
        });
        const label = `${viewport.width}x${viewport.height}-${textSize}`;
        const geometry = await ui('region', '十六进制报文分析器').evaluate((area) => {
          const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
          const main = area.closest('main');
          const bytes = area.querySelector('[aria-label="报文字节视图"]');
          return { workspace: rect(area), mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
            layer: rect(area.querySelector('[data-testid="packet-layer-panel"]')),
            results: rect(area.querySelector('[data-testid="packet-result-panels"]')),
            bytePanel: rect(area.querySelector('[data-testid="packet-byte-panel"]')),
            fieldPanel: rect(area.querySelector('[data-testid="packet-field-panel"]')),
            byteWidth: bytes.clientWidth, byteScrollWidth: bytes.scrollWidth };
        });
        assert.ok(geometry.mainScrollWidth <= geometry.mainWidth + 1, `${label}: no page-wide horizontal overflow`);
        assert.ok(geometry.workspace.x >= 0 && geometry.workspace.right <= viewport.width + 1, `${label}: workspace fits the client`);
        assert.ok(geometry.byteScrollWidth <= geometry.byteWidth + 1, `${label}: automatic byte columns do not need horizontal scrolling`);
        assert.ok(geometry.bytePanel.height >= 190 && geometry.fieldPanel.height >= 176, `${label}: both result panes retain useful reading heights`);
        if (geometry.workspace.width > 720) {
          assert.ok(geometry.results.x >= geometry.layer.right - 1, `${label}: protocol selection stays beside both result panes`);
          assert.ok(Math.abs(geometry.results.y - geometry.layer.y) <= 2, `${label}: inspector columns align at the top`);
          assert.ok(geometry.bytePanel.x >= geometry.layer.right - 1 && geometry.fieldPanel.x >= geometry.layer.right - 1,
            `${label}: bytes and fields stay in the result column, not underneath protocol selection`);
        }
        assert.match(await selected.innerText(), /24576[\s\S]*96/, `${label}: resizing preserves linked UDP source port values`);
        assert.equal(await ui('button', '0x0022: 60').getAttribute('aria-pressed'), 'true', `${label}: selected byte remains highlighted after resize`);
        if (viewport.width === 1280 && textSize === 'comfortable') {
          const tab = await ui('tab', '标准字段').boundingBox();
          const firstField = await ui('button', '源端口').boundingBox();
          assert.ok(tab.y >= 0 && tab.y + tab.height <= viewport.height,
            'Default client shows the standard-field tab without scrolling the whole page');
          assert.ok(firstField.y >= 0 && firstField.y + firstField.height <= viewport.height,
            'Default client shows at least the first decoded field below the byte viewer');
        }
        await page.screenshot({ path: path.join(output, `layout-${label}.png`), fullPage: true });

        const payloadNode = page.getByTestId('payload-layer-node').filter({ has: page.getByRole('button', { name: /^定义载荷字段/ }) }).first();
        const definePayload = payloadNode.getByRole('button', { name: /^定义载荷字段/ });
        assert.equal(await definePayload.count(), 1, `${label}: payload definition belongs to the actual payload node`);
        const placement = await definePayload.evaluate((button) => {
          const node = button.closest('[data-testid="payload-layer-node"]').getBoundingClientRect();
          const action = button.getBoundingClientRect();
          return { nodeLeft: node.left, nodeRight: node.right, nodeTop: node.top, nodeBottom: node.bottom,
            left: action.left, right: action.right, top: action.top, bottom: action.bottom, height: action.height };
        });
        assert.ok(placement.left >= placement.nodeLeft && placement.right <= placement.nodeRight + 1
          && placement.top >= placement.nodeTop && placement.bottom <= placement.nodeBottom + 1,
        `${label}: define payload action is contained by the payload item, never floating between columns`);
        assert.ok(placement.height >= 28, `${label}: payload action remains usable without squeezing`);
        await definePayload.click();
        await fieldEditorIsFocusedAndVisible(`${label}/payload definition`);
        assert.equal(await ui('textbox', '字段起始偏移').inputValue(), '42', `${label}: definition uses the payload's absolute offset`);
        assert.equal(await ui('textbox', '字段长度').inputValue(), '24', `${label}: definition uses the payload's complete length`);
        assert.match(await selected.innerText(), /0x002A \/ 42[\s\S]*24 字节/);
        await page.screenshot({ path: path.join(output, `payload-editor-${label}.png`), animations: 'disabled' });
        await ui('textbox', '字段名称').fill('不应写入存储');
        // Reopening an already-open editor must refocus it, not leave it offscreen.
        await definePayload.click();
        await fieldEditorIsFocusedAndVisible(`${label}/reopened payload definition`);
        assert.equal(await ui('textbox', '字段名称').inputValue(), '');
        await ui('button', '取消').click();
        assert.equal(await ui('textbox', '字段名称').count(), 0, `${label}: cancelling does not create another field`);
        assert.match(await ui('tab', '自定义字段 (1)').innerText(), /1/);
        await ui('tab', '标准字段').click();

        await ui('combobox', '每行字节数').selectOption('32');
        const manualOverflow = await ui('region', '报文字节视图').evaluate((area) => {
          const main = area.closest('main');
          return { columns: area.style.getPropertyValue('--byte-columns'), overflowX: getComputedStyle(area).overflowX,
            width: main.clientWidth, scrollWidth: main.scrollWidth };
        });
        assert.equal(manualOverflow.columns, '32', `${label}: manual 32-byte choice remains honored`);
        assert.equal(manualOverflow.overflowX, 'auto', `${label}: any wide manual rows scroll only in the byte pane`);
        assert.ok(manualOverflow.scrollWidth <= manualOverflow.width + 1, `${label}: 32-byte rows cannot widen the page`);
        await ui('combobox', '每行字节数').selectOption('auto');
        console.log(`PASS packet layout ${label}: local byte scrolling, attached payload action and visible editor.`);
      }
    }
    // Recreate the tool at both 100% and 125%-equivalent default widths, not just
    // resize an existing selection, to exercise the first ResizeObserver delivery.
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1008, height: 610 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
      await ui('button', '← 返回工具列表').click();
      await openTool();
      await page.waitForFunction(() => {
        const area = document.querySelector('[aria-label="报文字节视图"]');
        return Number(area.style.getPropertyValue('--byte-columns')) === (area.clientWidth < 612 ? 8 : 16);
      });
      assert.equal(await ui('region', '报文字节视图').evaluate((area) => area.scrollTop), 0,
        `${viewport.width}px: initial automatic sizing does not jump directly to the selected UDP row`);
      const firstByte = await ui('button', '0x0000: 00').boundingBox();
      const bytes = await ui('region', '报文字节视图').boundingBox();
      assert.ok(firstByte.y >= bytes.y && firstByte.y + firstByte.height <= bytes.y + bytes.height,
        `${viewport.width}px: the Ethernet start remains visible on first entry`);
      await page.screenshot({ path: path.join(output, `initial-${viewport.width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: parsed fields vs raw-byte semantics, linked selections, custom persistence/edit, dirty state, clear, 64 KiB virtualization and resize selection, automatic/manual row widths, offset validation, collapse, sixteen window/text-size layouts and payload editor focus.');
    console.log(`Screenshots: ${output}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
