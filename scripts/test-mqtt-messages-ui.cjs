/** Message-first MQTT UI regression. Isolated profile; every broker and clipboard call is synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { addFixture } = require('./test-device-debuggers-ui.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await addFixture(context);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/mqtt-messages'); fs.mkdirSync(output, { recursive: true });
  const area = () => page.getByTestId('mqtt-workspace');
  const list = () => page.getByRole('listbox', { name: 'MQTT 消息列表', exact: true });
  const rows = () => list().getByRole('option');
  const detail = () => page.getByTestId('mqtt-detail');
  const filter = () => page.getByLabel('筛选 MQTT 消息', { exact: true });
  const direction = () => page.getByLabel('MQTT 消息方向', { exact: true });
  const follow = () => page.getByLabel('跟随最新消息', { exact: true });
  const payload = () => page.getByLabel('消息内容', { exact: true });
  const count = (type) => page.evaluate((type) => window.__deviceFixture.requests.filter((request) => request.type === type).length, type);
  const waitRows = (length) => page.waitForFunction((length) => document.querySelectorAll('[aria-label="MQTT 消息列表"] [role="option"]').length === length, length);
  async function inject(entries) {
    await page.evaluate((entries) => {
      const f = window.__deviceFixture;
      for (const item of entries) {
        const hex = item.hex ?? Array.from(new TextEncoder().encode(item.text ?? ''), (byte) => byte.toString(16).padStart(2, '0')).join('');
        const event = { id: ++f.sequence, timestamp: Date.now(), kind: item.kind ?? 'message', topic: item.topic, qos: item.qos ?? 1, retain: item.retain ?? false, payloadHex: hex, byteLength: hex.length / 2 };
        f.mqttEvents.push(event);
        if (event.kind === 'message') { f.mqtt.rxMessages++; f.mqtt.rxBytes += event.byteLength; }
        else { f.mqtt.txMessages++; f.mqtt.txBytes += event.byteLength; }
      }
    }, entries);
  }
  async function closeDetail() { if (await detail().count()) await page.getByRole('button', { name: '收起消息详情', exact: true }).click(); }
  async function dimensions(label) {
    const geometry = await area().evaluate((area) => {
      const rect = (el) => { const box = el.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
      const main = area.closest('main');
      const controls = area.querySelector('[data-testid="mqtt-controls"]');
      const messages = area.querySelector('[data-testid="mqtt-messages"]');
      const list = area.querySelector('[aria-label="MQTT 消息列表"]');
      return { outerWidth: main.clientWidth, outerScrollWidth: main.scrollWidth,
        controls: rect(controls), messages: rect(messages), list: rect(list),
        controlsWidth: controls.clientWidth, controlsScrollWidth: controls.scrollWidth,
        listWidth: list.clientWidth, listScrollWidth: list.scrollWidth };
    });
    const viewport = page.viewportSize();
    assert.ok(geometry.outerScrollWidth <= geometry.outerWidth + 1, `${label}: no page horizontal overflow`);
    assert.ok(geometry.controlsScrollWidth <= geometry.controlsWidth + 1, `${label}: controls stay within their column`);
    assert.ok(geometry.listScrollWidth <= geometry.listWidth + 1, `${label}: long topic and payload do not widen messages`);
    assert.ok(geometry.list.height >= 340, `${label}: at least 340px for browsing messages, actual ${geometry.list.height}`);
    assert.ok(geometry.messages.right <= viewport.width + 1, `${label}: message controls fit client width`);
    if (viewport.width > 900) {
      assert.ok(geometry.messages.x >= geometry.controls.right, `${label}: left operations and right messages are side by side`);
      assert.ok(Math.abs(geometry.messages.y - geometry.controls.y) <= 2, `${label}: two columns align`);
    }
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true, animations: 'disabled' });
    console.log(`PASS MQTT ${label}: ${Math.round(geometry.list.height)}px message viewport, no horizontal overflow.`);
  }

  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'MQTT 调试助手', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    await area().waitFor();
    assert.equal(await count('mqtt.start'), 0, 'opening the tool does not connect');
    assert.equal(await count('mqtt.publish'), 0, 'opening the tool never publishes');
    assert.equal(await detail().count(), 0, 'no empty detail pane competes with message list');
    await area().getByRole('button', { name: '连接 Broker', exact: true }).click();
    await area().getByRole('button', { name: '断开连接', exact: true }).waitFor();

    await inject(Array.from({ length: 600 }, (_, i) => ({ topic: `factory/line${i}/state`, kind: i % 3 ? 'message' : 'published', text: `设备 ${i} 温度 ${20 + i} ℃`, qos: i % 3, retain: i % 5 === 0 })));
    await waitRows(600);
    assert.equal(await detail().count(), 0, 'new messages do not select or open detail automatically');
    assert.equal(await rows().filter({ hasText: '设备 598 温度 618 ℃' }).count(), 1, 'payload preview is readable directly in each row');
    assert.equal(await rows().filter({ hasText: /RX.*接收/ }).count(), 400, 'receive direction has both text and code');
    assert.equal(await rows().filter({ hasText: /TX.*发布/ }).count(), 200, 'publish direction has both text and code');
    assert.equal(await rows().filter({ hasText: /Retain/ }).count(), 120, 'full-width list identifies retained messages without opening details');
    const colors = await rows().evaluateAll((options) => {
      const styles = (element) => [element, ...element.querySelectorAll('*')].map((child) => {
        const css = getComputedStyle(child); return `${css.color}|${css.backgroundColor}|${css.borderLeftColor}`;
      });
      return { rx: styles(options.find((row) => row.textContent.includes('RX'))), tx: styles(options.find((row) => row.textContent.includes('TX'))) };
    });
    assert.notDeepEqual(colors.rx, colors.tx, 'receive/publish indicators have distinct visual colors');

    // Reading history must never let incoming traffic drag the list or replace detail.
    await rows().nth(100).click();
    await detail().waitFor();
    assert.equal(await follow().isChecked(), false, 'explicit message selection pauses follow, not reception');
    assert.ok((await payload().innerText()).includes('设备 100 温度 120 ℃'));
    const frozenTop = await list().evaluate((el) => el.scrollTop);
    const frozenPayload = await payload().innerText();
    const stopsBefore = await count('mqtt.stop');
    const pollsBefore = await count('mqtt.poll');
    await inject(Array.from({ length: 40 }, (_, i) => ({ topic: `new/${i}`, text: `new payload ${i}` })));
    await waitRows(640);
    assert.equal(await payload().innerText(), frozenPayload, 'receiving preserves selected detail');
    assert.ok(Math.abs(await list().evaluate((el) => el.scrollTop) - frozenTop) <= 2, 'receiving preserves history scroll position');
    await page.getByRole('button', { name: /查看新消息/ }).waitFor();
    assert.equal(await count('mqtt.stop'), stopsBefore, 'pause follow does not close the MQTT session');
    assert.ok(await count('mqtt.poll') > pollsBefore, 'pause follow keeps polling and receiving');

    await filter().fill('new payload 39');
    await waitRows(1);
    if (await detail().count()) assert.equal(await payload().innerText(), frozenPayload, 'filtering cannot switch detail to a different row');
    assert.ok((await rows().first().innerText()).includes('new/39'), 'payload keyword filtering works, not just topics');
    await filter().fill('factory/line100/state');
    await waitRows(1);
    await rows().first().click();
    assert.equal(await payload().innerText(), frozenPayload, 'topic filtering preserves exact row identity');
    await filter().fill(''); await waitRows(640);
    await direction().selectOption('tx'); await waitRows(200);
    assert.equal(await rows().filter({ hasText: /RX.*接收/ }).count(), 0);
    await direction().selectOption('rx'); await waitRows(440);
    assert.equal(await rows().filter({ hasText: /TX.*发布/ }).count(), 0);
    await direction().selectOption('all'); await waitRows(640);
    await closeDetail();
    const messageButton = page.getByRole('button', { name: /查看新消息/ });
    if (await messageButton.count()) await messageButton.click(); else await follow().check();
    assert.equal(await follow().isChecked(), true);
    await inject([{ topic: 'follow/latest', text: 'follow latest payload' }]);
    await waitRows(641);
    await page.waitForFunction(() => { const el = document.querySelector('[aria-label="MQTT 消息列表"]'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 3; });

    await inject([
      { topic: 'binary/blob', hex: '00ff0a', qos: 2 },
      { topic: 'empty/retained', text: '', retain: true },
      { topic: '<img src=x onerror=window.bad=1>', text: '<script>window.bad=1</script>' },
      { topic: `long/${'segment/'.repeat(100)}`, text: `prefix ${'a'.repeat(800)} FULL_PAYLOAD_SEARCH_SUFFIX` },
      { topic: 'binary/bom-only', hex: 'efbbbf' },
    ]);
    await waitRows(646);
    await filter().fill('binary/blob'); await waitRows(1); await rows().first().click();
    await detail().getByRole('button', { name: 'HEX', exact: true }).click();
    assert.equal(await payload().innerText(), '00 FF 0A', 'binary full detail is exact HEX');
    await detail().getByRole('button', { name: '复制', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__deviceFixture.clipboard.at(-1)), '00 FF 0A');
    await filter().fill('empty/retained'); await waitRows(1); await rows().first().click();
    assert.match(await payload().innerText(), /空载荷|0 字节/, 'selected empty retained publication is distinguished from no selection');
    assert.match(await detail().innerText(), /Retain|保留/, 'retained message has a readable flag in selected detail');
    await filter().fill('FULL_PAYLOAD_SEARCH_SUFFIX'); await waitRows(1);
    await rows().first().click();
    await detail().getByRole('button', { name: '文本', exact: true }).click();
    assert.ok((await payload().innerText()).endsWith('FULL_PAYLOAD_SEARCH_SUFFIX'), 'search covers payload beyond row preview truncation');
    assert.equal(await page.evaluate(() => window.bad), undefined, 'HTML-like payload and topic are rendered as inert text');
    await filter().fill('binary/bom-only'); await waitRows(1); await rows().first().click();
    assert.doesNotMatch(await rows().first().innerText(), /空载荷|0 字节/, 'BOM-only nonempty bytes are not labelled as empty');
    assert.doesNotMatch(await payload().innerText(), /空载荷|0 字节/, 'BOM-only detail does not claim a zero-byte payload');
    await detail().getByRole('button', { name: 'HEX', exact: true }).click();
    assert.equal(await payload().innerText(), 'EF BB BF', 'BOM-only bytes remain inspectable');
    await filter().fill(''); await waitRows(646); await closeDetail();

    // All desktop sizes retain a useful list viewport. Small screens may scroll vertically.
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1040 }, { width: 1024, height: 640 }, { width: 760, height: 560 }]) {
      await page.setViewportSize(viewport);
      for (const textSize of ['comfortable', 'large']) {
        await page.evaluate((value) => { document.documentElement.dataset.workspaceTextSize = value; }, textSize);
        const label = `${viewport.width}x${viewport.height}-${textSize}`;
        await dimensions(label);
        await rows().first().click(); await detail().waitFor();
        const main = await page.getByRole('main').last().evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(main.scroll <= main.width + 1, `${label}: expanded detail cannot cause horizontal scrolling`);
        if (viewport.width >= 1280) {
          const messageBox = await list().boundingBox(); const detailBox = await detail().boundingBox();
          assert.ok(detailBox.x >= messageBox.x + messageBox.width - 1, `${label}: default and maximized views place details beside messages`);
        }
        const firstSelectedId = await list().locator('[role="option"][aria-selected="true"]').getAttribute('data-message-id');
        await detail().getByRole('button', { name: '下一条 MQTT 消息', exact: true }).click();
        assert.notEqual(await list().locator('[role="option"][aria-selected="true"]').getAttribute('data-message-id'), firstSelectedId, `${label}: details navigate without repeatedly closing the drawer`);
        await detail().getByRole('button', { name: '上一条 MQTT 消息', exact: true }).click();
        assert.equal(await list().locator('[role="option"][aria-selected="true"]').getAttribute('data-message-id'), firstSelectedId, `${label}: previous message restores the original selection`);
        await page.screenshot({ path: path.join(output, `${label}-detail.png`), fullPage: true, animations: 'disabled' });
        await closeDetail();
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await rows().first().click();
    await inject(Array.from({ length: 2100 }, (_, i) => ({ topic: `bounded/${i}`, text: `bounded payload ${i}` })));
    await waitRows(2000);
    assert.equal(await rows().filter({ hasText: 'factory/line0/state' }).count(), 0, 'oldest messages are trimmed at row budget');
    assert.equal(await rows().filter({ hasText: 'bounded/2099' }).count(), 1, 'latest message survives row budget');
    assert.equal(await list().locator('[role="option"][aria-selected="true"]').count(), 0, 'evicted selection never falls back to a different row');
    if (await detail().count()) assert.ok(!(await payload().innerText()).includes('bounded payload'), 'trimming cannot show another payload as selected');
    await closeDetail();

    // Retention accounts for HEX, decoded/search strings and previews, not wire bytes alone.
    // Each 200 KiB ASCII payload occupies about 1.6 MiB including UTF-16 caches.
    await page.evaluate(() => {
      const f = window.__deviceFixture;
      for (let i = 0; i < 12; ++i) f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'message', topic: `memory/${i}`, qos: 0, retain: false, payloadHex: '61'.repeat(200 * 1024), byteLength: 200 * 1024 });
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="MQTT 消息列表"]').textContent.includes('memory/11'));
    assert.equal(await rows().count(), 2, '4 MiB memory budget includes decoded payload and search cache');
    await rows().first().click();
    await area().getByRole('button', { name: '清空', exact: true }).click();
    await waitRows(0);
    assert.equal(await detail().count(), 0, 'clear removes selected details rather than retaining stale payload');
    assert.equal(await count('mqtt.stop'), stopsBefore, 'browse/search/clear actions do not disconnect');
    assert.equal(await count('mqtt.publish'), 0, 'browse/search/selection never publishes to the broker');

    // A drained poll response can arrive after newer commands. Keep its messages,
    // but never restore its older subscription list or TX counters over commands.
    await page.evaluate(() => {
      const f = window.__deviceFixture;
      f.holdNextMqttPoll = true;
      f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'message', topic: 'race/drained-before-command', qos: 1, retain: false, payloadHex: '4f4b', byteLength: 2 });
    });
    await page.waitForFunction(() => window.__deviceFixture.heldMqttPoll === true);
    await page.getByLabel('MQTT 订阅主题', { exact: true }).fill('race/+/state');
    await area().getByRole('button', { name: '订阅', exact: true }).click();
    await page.getByLabel('取消订阅 race/+/state', { exact: true }).waitFor();
    const txAfterCommands = await page.evaluate(() => window.__deviceFixture.mqtt.txMessages + 1);
    await page.getByRole('region', { name: 'MQTT 发布', exact: true }).getByRole('button', { name: /^发布/ }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'mqtt.publish'));
    await page.waitForFunction((count) => document.querySelector('[data-testid="mqtt-messages"] > header').textContent.includes(`TX ${count}`), txAfterCommands);
    await page.evaluate(() => window.__deviceFixture.releaseMqttPoll());
    await waitRows(2);
    assert.equal(await rows().filter({ hasText: 'race/drained-before-command' }).count(), 1, 'already-drained receive messages survive late poll delivery');
    assert.equal(await rows().filter({ hasText: /TX.*发布/ }).count(), 1, 'newly published messages also arrive after delayed poll');
    assert.equal(await page.getByLabel('取消订阅 race/+/state', { exact: true }).count(), 1, 'late poll cannot erase newer subscription snapshot');
    assert.ok((await page.getByTestId('mqtt-messages').locator(':scope > header').innerText()).includes(`TX ${txAfterCommands}`), 'late poll cannot roll back newer TX counter');

    await page.evaluate(() => {
      const f = window.__deviceFixture; f.holdNextMqttPoll = true;
      f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'message', topic: 'race/drained-before-stop', qos: 1, retain: false, payloadHex: '4f4b', byteLength: 2 });
    });
    await page.waitForFunction(() => window.__deviceFixture.heldMqttPoll === true);
    await area().getByRole('button', { name: '断开连接', exact: true }).click();
    await area().getByRole('button', { name: '连接 Broker', exact: true }).waitFor();
    await page.evaluate(() => window.__deviceFixture.releaseMqttPoll());
    await waitRows(3);
    assert.equal(await rows().filter({ hasText: 'race/drained-before-stop' }).count(), 1, 'disconnect preserves already-drained final receive messages');
    assert.equal(await area().getByRole('button', { name: '连接 Broker', exact: true }).count(), 1, 'late poll cannot restore the connected state after stop');

    await area().getByRole('button', { name: '连接 Broker', exact: true }).click();
    await area().getByRole('button', { name: '断开连接', exact: true }).waitFor();
    await waitRows(0);
    await page.evaluate(() => {
      const f = window.__deviceFixture; f.holdNextMqttPoll = true;
      f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'message', topic: 'race/old-session', qos: 1, retain: false, payloadHex: '4f4b', byteLength: 2 });
    });
    await page.waitForFunction(() => window.__deviceFixture.heldMqttPoll === true);
    await area().getByRole('button', { name: '断开连接', exact: true }).click();
    await area().getByRole('button', { name: '连接 Broker', exact: true }).click();
    await area().getByRole('button', { name: '断开连接', exact: true }).waitFor();
    await page.evaluate(() => window.__deviceFixture.releaseMqttPoll());
    await inject([{ topic: 'race/new-session', text: 'fresh session message' }]);
    await waitRows(1);
    assert.equal(await rows().filter({ hasText: 'race/new-session' }).count(), 1, 'new session receives its own messages');
    assert.equal(await rows().filter({ hasText: 'race/old-session' }).count(), 0, 'restart rejects delayed messages from the previous session');
    await page.locator('header[aria-label="工具详情导航"]').getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await page.waitForFunction(() => window.__deviceFixture.mqtt.state === 'stopped');
    assert.deepEqual(errors, [], 'no unhandled browser or React errors');
    console.log('PASS MQTT message-first browsing: payload previews, topic/content/direction filters, explicit stable selection, binary/empty Retain, follow without reception loss, history position, bounded 2000/4 MiB history and 8 responsive layouts. All broker traffic synthetic.');
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
