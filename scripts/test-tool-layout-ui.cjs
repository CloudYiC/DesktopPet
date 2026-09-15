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
  const toolHome = () => page.getByRole('button', { name: /^工具首页/ }).click();
  const openTool = async (name) => {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    assert.equal(await card.getByRole('button', { name: /^(Enable|启用|停用)$/ }).count(), 0, 'built-in tools never require enabling');
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await header().waitFor();
  };
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await toolHome();
    fs.mkdirSync(output, { recursive: true });
    const cards = await page.getByRole('article').filter({ has: page.getByRole('button', { name: '打开', exact: true }) }).evaluateAll((elements) =>
      elements.map((element) => ({ name: element.querySelector('h3').textContent, description: element.querySelector('p').textContent })));
    assert.equal(cards.length, 20);
    assert.equal(cards.filter((card) => card.name === '网络调试助手').length, 1);
    assert.equal(cards.some((card) => card.name === '发包工具'), false);
    assert.equal(Math.round((await sidebar().boundingBox()).width), 192);
    for (const name of ['home', 'data', 'network', 'system', 'file-conversion', 'today', 'all', 'status', 'settings']) {
      const icon = sidebar().locator(`svg[data-nav-icon="${name}"]`).first();
      assert.equal(await icon.getAttribute('aria-hidden'), 'true', `${name} is decorative, not repeated by screen readers`);
      assert.equal(await icon.getAttribute('stroke'), 'currentColor', `${name} follows the navigation state color`);
      assert.equal(await icon.getAttribute('viewBox'), '0 0 24 24');
    }
    assert.equal(await sidebar().getByRole('button', { name: /^工具首页/ }).getAttribute('aria-current'), 'page');
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
      const toolOverflow = await page.getByRole('main').last().evaluate((area) => ({ width: area.clientWidth, scrollWidth: area.scrollWidth }));
      assert.ok(toolOverflow.scrollWidth <= toolOverflow.width + 1, `${name} has no page-wide horizontal overflow at the default window`);
      if (['JSON 格式化', '网络调试助手', 'MQTT 调试助手', 'Modbus 调试助手', '十六进制报文分析器'].includes(name)) {
        await page.screenshot({ path: path.join(output, `${name}-1280.png`), fullPage: true });
      }
      await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      assert.ok(await page.getByRole('article').filter({ hasText: description }).count(), `${name} description is still in catalog`);
    }
    for (const width of [1024, 920, 760]) {
      await page.setViewportSize({ width, height: 800 });
      for (const name of ['JSON 格式化', '网络调试助手', 'MQTT 调试助手', 'Modbus 调试助手', '十六进制报文分析器']) {
        await openTool(name);
        const frame = await header().boundingBox();
        assert.ok(frame.x + frame.width <= width, `${name} header fits ${width}px`);
        await page.screenshot({ path: path.join(output, `${name}-${width}.png`), fullPage: true });
        await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      }
    }
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1040 }, { width: 1024, height: 640 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const textSize of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, textSize);
        await openTool('网络调试助手');
        const geometry = await page.getByTestId('network-workspace').evaluate((area) => {
          const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
          const main = area.closest('main');
          const operations = area.querySelector('[data-testid="network-operations"]');
          const actions = area.querySelector('[data-testid="network-send-actions"]');
          return { mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
            editor: rect(area.querySelector('[data-testid="packet-sender-editor"]')),
            results: rect(area.querySelector('[data-testid="packet-sender-results"]')),
            log: rect(area.querySelector('[role="log"]')),
            actionsInsideOperations: operations.contains(actions),
            actionsPosition: getComputedStyle(actions).position,
            hasPermanentLibrary: !!area.querySelector('[data-testid="packet-library-panel"]') };
        });
        const label = `${viewport.width}x${viewport.height}/${textSize}`;
        assert.ok(geometry.mainScrollWidth <= geometry.mainWidth + 1, `${label}: network details have no horizontal scrollbar`);
        assert.ok(geometry.log.height >= 340, `${label}: log retains at least 340px reading height`);
        assert.ok(geometry.results.right <= viewport.width, `${label}: result controls remain within client width`);
        assert.ok(geometry.actionsInsideOperations, `${label}: line endings, interval and sending controls share the left operations scroller`);
        assert.ok(!['fixed', 'sticky'].includes(geometry.actionsPosition), `${label}: sending controls are not a fixed bottom dock`);
        assert.equal(geometry.hasPermanentLibrary, false, `${label}: templates do not occupy a permanent result panel`);
        if (viewport.width > 900) {
          assert.ok(geometry.results.x >= geometry.editor.right, `${label}: edit and results remain side by side`);
          assert.ok(Math.abs(geometry.editor.y - geometry.results.y) < 2, `${label}: the two columns share their top edge`);
        }
        const scrolling = await page.getByTestId('network-operations').evaluate((area) => {
          const actions = area.querySelector('[data-testid="network-send-actions"]');
          area.scrollTop = 0;
          const before = actions.getBoundingClientRect().top;
          area.scrollTop = Math.min(120, area.scrollHeight - area.clientHeight);
          const delta = area.scrollTop;
          const shift = before - actions.getBoundingClientRect().top;
          area.scrollTop = 0;
          return { delta, shift };
        });
        assert.ok(Math.abs(scrolling.delta - scrolling.shift) < 2, `${label}: sending controls move with the left panel when it scrolls`);
        await page.screenshot({ path: path.join(output, `network-unified-${label.replace('/', '-')}.png`), fullPage: true });
        await page.getByRole('button', { name: '报文模板', exact: true }).click();
        const templateDialog = page.getByRole('dialog', { name: '报文模板', exact: true });
        await templateDialog.waitFor();
        const templateLayout = await templateDialog.evaluate((area) => {
          const box = area.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, clientWidth: area.clientWidth, scrollWidth: area.scrollWidth,
            focusedInside: area.contains(document.activeElement), focusedTag: document.activeElement?.tagName };
        });
        assert.ok(Math.abs(templateLayout.x + templateLayout.width / 2 - viewport.width / 2) <= 2, `${label}: templates center on the whole client horizontally`);
        assert.ok(Math.abs(templateLayout.y + templateLayout.height / 2 - viewport.height / 2) <= 2, `${label}: templates center on the whole client vertically`);
        assert.ok(templateLayout.x >= 0 && templateLayout.y >= 0 && templateLayout.x + templateLayout.width <= viewport.width + 1
          && templateLayout.y + templateLayout.height <= viewport.height + 1, `${label}: template dialog fits the viewport`);
        assert.ok(templateLayout.scrollWidth <= templateLayout.clientWidth + 1, `${label}: template dialog has no horizontal overflow`);
        assert.ok(templateLayout.focusedInside && templateLayout.focusedTag === 'INPUT', `${label}: template dialog opens with search focus`);
        await page.screenshot({ path: path.join(output, `network-templates-${label.replace('/', '-')}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await templateDialog.waitFor({ state: 'hidden' });
        assert.ok(await page.getByRole('button', { name: '报文模板', exact: true }).evaluate((element) => element === document.activeElement), `${label}: closing templates restores the trigger focus`);
        console.log(`PASS unified network ${label}: log ${Math.round(geometry.log.height)}px; no horizontal overflow.`);
        await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1040 }, { width: 1024, height: 640 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const textSize of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, textSize);
        for (const [name, prefix, selector, minHeight] of [['MQTT 调试助手', 'mqtt', '[aria-label="MQTT 消息列表"]', 340], ['Modbus 调试助手', 'modbus', '[data-testid="modbus-data"]', 300]]) {
          await openTool(name);
          const geometry = await page.getByTestId(`${prefix}-workspace`).evaluate((area, { prefix, selector }) => {
            const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height }; };
            const main = area.closest('main');
            return { width: main.clientWidth, scrollWidth: main.scrollWidth,
              controls: rect(area.querySelector(`[data-testid="${prefix}-controls"]`)),
              result: rect(area.querySelector(`[data-testid="${prefix === 'mqtt' ? 'mqtt-messages' : 'modbus-results'}"]`)),
              reader: rect(area.querySelector(selector)) };
          }, { prefix, selector });
          const label = `${name}/${viewport.width}x${viewport.height}/${textSize}`;
          assert.ok(geometry.scrollWidth <= geometry.width + 1, `${label}: no page horizontal overflow`);
          assert.ok(geometry.reader.height >= minHeight, `${label}: browsing area retains a useful minimum height`);
          assert.ok(geometry.result.right <= viewport.width + 1, `${label}: result actions stay inside the client`);
          if (viewport.width > 900) {
            assert.ok(geometry.result.x >= geometry.controls.right, `${label}: results are beside controls`);
            assert.ok(Math.abs(geometry.result.y - geometry.controls.y) < 2, `${label}: columns align`);
          }
          await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
        }
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: /^今天/ }).click();
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
