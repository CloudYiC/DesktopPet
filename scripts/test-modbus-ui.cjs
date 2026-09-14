/** Modbus-only UI contracts. Isolated synthetic host; no real COM/TCP/clipboard. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const snapshot = { state: 'stopped', transport: 'tcp', pending: false, error: '', result: null };
    const f = window.__modbusFixture = { snapshot, requests: [], logs: [], clipboard: [], sequence: 0, generation: 0, hold: false, failNextRequest: false, nextValues: null, delayNextPoll: false, delayedPoll: null, completeRequest: null };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => f.clipboard.push(text) } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = { addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener),
      postMessage: (request) => {
        f.requests.push(request);
        if (request.type === 'app.ready') { setTimeout(() => listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { reminders: [], now: Date.now(), petName: '依依', characters: [], openLastView: true, lastDashboardView: 'toolbox', lastToolCategory: 'network', workspaceTheme: 'warm', workspaceTextSize: 'comfortable' } } })), 10); return; }
        if (!request.type.startsWith('modbus.')) return;
        const p = request.payload || {}, action = request.type.split('.')[1];
        if (action === 'request' && f.failNextRequest) {
          f.failNextRequest = false;
          setTimeout(() => listeners.forEach((listener) => listener({ data: { type: `${request.type}.error`, payload: { requestId: p.requestId, message: 'Synthetic write timeout' } } })), 10);
          return;
        }
        let response;
        if (action === 'ports') response = { ports: ['COM3'] };
        else {
          if (action === 'start') Object.assign(snapshot, { state: 'connected', pending: false, unitId: p.unitId, transport: p.transport, endpoint: p.transport === 'tcp' ? `${p.host}:${p.port}` : p.serialPort, result: null, error: '' });
          if (action === 'stop') { ++f.generation; Object.assign(snapshot, { state: 'stopped', pending: false, result: null }); }
          if (action === 'request') {
            const generation = f.generation; Object.assign(snapshot, { pending: true, result: null, error: '' });
            const nextValues = f.nextValues; f.nextValues = null;
            f.completeRequest = () => {
              if (generation !== f.generation) return;
              const written = [5,6,15,16].includes(p.functionCode);
              snapshot.result = { id: ++f.sequence, functionCode: p.functionCode, address: p.address, quantity: p.quantity, values: written ? p.values : nextValues || Array.from({ length: p.quantity }, (_, i) => p.functionCode <= 2 ? i % 2 : i), written, timestamp: Date.now(), elapsedMs: 50 };
              snapshot.pending = false;
              f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'TX', hex: '01 03 00 00 00 08 44 0C', message: '' });
            };
            if (!f.hold) setTimeout(f.completeRequest, 70);
          }
          response = { snapshot: { ...snapshot }, logs: action === 'poll' ? f.logs.splice(0) : [] };
        }
        const deliver = () => listeners.forEach((listener) => listener({ data: { type: `${request.type}.result`, payload: { requestId: p.requestId, ...response } } }));
        if (action === 'poll' && f.delayNextPoll) {
          f.delayNextPoll = false; f.delayedPoll = deliver;
          f.rejectDelayedPoll = () => listeners.forEach((listener) => listener({ data: { type: `${request.type}.error`, payload: { requestId: p.requestId, message: 'obsolete poll error' } } }));
        }
        else setTimeout(deliver, 10);
      } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = [], nativeDialogs = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  const directory = path.resolve(__dirname, '../artifacts/modbus'); fs.mkdirSync(directory, { recursive: true });
  const area = () => page.getByTestId('modbus-workspace');
  const label = (text) => area().getByLabel(text, { exact: true });
  const button = (name) => area().getByRole('button', { name, exact: true });
  const requestCount = () => page.evaluate(() => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').length);
  const lastRequest = () => page.evaluate(() => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').at(-1).payload);
  const waitDone = () => page.waitForFunction(() => window.__modbusFixture.snapshot.result && !window.__modbusFixture.snapshot.pending);
  async function fit(name, strict = true) {
    const main = await page.getByRole('main').last().evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight }));
    assert.ok(main.scrollWidth <= main.width + 1, `${name}: no horizontal page overflow`);
    if (strict && page.viewportSize().height >= 762) assert.ok(main.scrollHeight <= main.height + 1, `${name}: default page stays fixed ${JSON.stringify(main)}`);
    const viewport = page.viewportSize();
    const controls = await page.getByTestId('modbus-controls').boundingBox();
    const results = await page.getByTestId('modbus-results').boundingBox();
    const dataHeading = await page.getByTestId('modbus-results').getByRole('heading', { name: '寄存器数据', exact: true }).boundingBox();
    assert.ok(dataHeading.height < 40, `${name}: data title does not collapse into vertical one-character lines`);
    if (viewport.width > 900) {
      assert.ok(controls.x + controls.width <= results.x, `${name}: parameters stay to the left of results`);
      assert.ok(Math.abs(controls.y - results.y) < 1, `${name}: both work columns begin on the same line`);
      if (strict && viewport.height >= 762) assert.ok(results.y + results.height <= viewport.height, `${name}: collapsed log and full-height table stay within the client`);
      assert.ok((await page.getByTestId('modbus-data').boundingBox()).height >= 299, `${name}: table keeps a readable minimum even when a short client must scroll`);
      if (viewport.width >= 1280 && viewport.height >= 762) {
        for (const name of ['连接设备', '断开连接', '读取', '写入…']) {
          const action = button(name);
          if (await action.count()) {
            const box = await action.boundingBox();
            assert.ok(box.y >= controls.y && box.y + box.height <= controls.y + controls.height, `${name}: primary operation visible alongside results by default`);
          }
        }
      }
    } else {
      assert.ok(results.y >= controls.y + controls.height, `${name}: only narrow clients stack the columns`);
    }
    assert.ok(await page.getByTestId('modbus-data').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${name}: table wraps complete values without horizontal overflow`);
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18768/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Modbus 调试助手', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    assert.equal(await area().getByRole('log', { name: 'Modbus 原始报文' }).count(), 0, 'raw bytes do not occupy a second panel until expanded');
    for (const size of ['comfortable', 'large']) {
      await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
      for (const transport of ['Modbus TCP', 'Modbus RTU']) {
        await area().getByRole('tab', { name: transport, exact: true }).click();
        for (const code of ['3','16']) {
          await label('Modbus 功能码').selectOption(code);
          for (const viewport of [{ width: 1280, height: 762 }, { width: 1920, height: 1080 }, { width: 1024, height: 640 }, { width: 920, height: 762 }, { width: 760, height: 650 }]) {
            await page.setViewportSize(viewport);
            await fit(`${transport}-${code}-${size}-${viewport.width}x${viewport.height}`, viewport.width > 900);
          }
          await page.setViewportSize({ width: 1280, height: 800 });
        }
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await area().getByRole('tab', { name: 'Modbus TCP', exact: true }).click(); await label('Modbus 功能码').selectOption('3');
    await button('连接设备').click(); await button('断开连接').waitFor();
    await label('按五位参考编号输入').check(); assert.equal(await label('Modbus 起始地址').inputValue(), '40001');
    await label('Modbus 起始地址').fill('40008'); await button('读取').click(); await waitDone();
    assert.equal((await lastRequest()).address, 7);
    await label('按五位参考编号输入').uncheck(); assert.equal(await label('Modbus 起始地址').inputValue(), '7');
    await label('Modbus 数量').fill('125'); await button('读取').click(); await waitDone();
    await page.waitForFunction(() => document.querySelector('[data-testid="modbus-data"] tbody')?.children.length === 125);
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 125, 'all register rows remain available');
    const resultsBeforeScroll = await page.getByTestId('modbus-results').boundingBox();
    assert.ok(await page.getByTestId('modbus-data').evaluate((el) => el.scrollHeight > el.clientHeight), '125 register values scroll only inside the data table');
    for (const viewport of [{ width: 1280, height: 762 }, { width: 1024, height: 640 }, { width: 920, height: 762 }]) {
      await page.setViewportSize(viewport);
      await fit(`populated-${viewport.width}x${viewport.height}`);
      assert.equal(await page.getByTestId('modbus-data').locator('thead th').count(), 5, 'all five result columns retained at narrow desktop widths');
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('modbus-data').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    assert.deepEqual(await page.getByTestId('modbus-results').boundingBox(), resultsBeforeScroll, 'reading the end of the result does not move its panel or request controls');
    // Refresh keeps the previous table available; compare only the same read scope.
    await page.evaluate(() => { const f = window.__modbusFixture; f.hold = true; f.nextValues = Array.from({ length: 125 }, (_, i) => i === 0 ? 65535 : i === 1 ? 42 : i); });
    await button('读取').click();
    await area().getByText('刷新中 · 保留上次结果', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 125, 'in-flight refresh never blanks the previous successful values');
    await page.evaluate(() => { const f = window.__modbusFixture; f.hold = false; f.completeRequest(); }); await waitDone();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tr[data-changed]').length === 2);
    await label('只看变化数据').check(); assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 2);
    await label('寄存器数据显示').selectOption('signed');
    await label('筛选 Modbus 数据').fill('0xFFFF');
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 1, 'HEX payload value filter works with signed display');
    await button('复制当前结果').click();
    assert.match(await page.evaluate(() => window.__modbusFixture.clipboard.at(-1)), /7\t40008\t0xFFFF\t-1/);
    assert.equal((await page.evaluate(() => window.__modbusFixture.clipboard.at(-1))).split('\n').length, 2, 'copy includes only the filtered row plus header');
    await label('筛选 Modbus 数据').fill(''); await label('只看变化数据').uncheck();
    await page.getByTestId('modbus-data').evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(directory, 'same-read-changes.png'), fullPage: true });
    // A new request must not discard bytes already drained by an older background poll.
    await page.evaluate(() => { const f = window.__modbusFixture; f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'RX', hex: 'CA FE', message: 'delayed poll frame' }); f.delayNextPoll = true; });
    await page.waitForFunction(() => !!window.__modbusFixture.delayedPoll);
    await button('读取').click(); await waitDone();
    await page.evaluate(() => { window.__modbusFixture.delayedPoll(); window.__modbusFixture.delayedPoll = null; });
    await button('展开报文').click(); await area().getByText('delayed poll frame', { exact: true }).waitFor();
    assert.match(await page.getByTestId('modbus-result-context').innerText(), /地址 7–131/, 'late snapshot does not replace current request scope');
    await button('收起报文').click();
    // A rejected old background poll cannot stop a newer explicit polling run.
    await label('轮询间隔毫秒').fill('100');
    await page.evaluate(() => { window.__modbusFixture.delayNextPoll = true; });
    await page.waitForFunction(() => !!window.__modbusFixture.delayedPoll);
    const beforeObsoletePoll = await requestCount(); await label('轮询读取').check();
    await page.waitForFunction((before) => window.__modbusFixture.requests.filter((request) => request.type === 'modbus.request').length > before, beforeObsoletePoll);
    await waitDone();
    await page.evaluate(() => { window.__modbusFixture.rejectDelayedPoll(); window.__modbusFixture.delayedPoll = null; });
    await page.waitForTimeout(70);
    assert.equal(await label('轮询读取').isChecked(), true, 'late error from a superseded poll cannot stop newer automatic reads');
    assert.equal(await area().getByText('obsolete poll error', { exact: true }).count(), 0, 'superseded poll error does not overwrite newer command feedback');
    await label('轮询读取').uncheck(); await waitDone();
    await label('Modbus 起始地址').fill('10');
    await page.waitForTimeout(350);
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 0, 'parameter edit does not resurrect the stale native snapshot on the next poll');
    await button('读取').click(); await waitDone();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length === 125);
    assert.equal(await page.getByTestId('modbus-data').locator('tr[data-changed]').count(), 0, 'different address ranges do not share a change baseline');
    await label('Modbus 功能码').selectOption('1'); await label('Modbus 数量').fill('16'); await button('读取').click(); await waitDone();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length === 16);
    await label('筛选 Modbus 数据').fill('on'); assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 8);
    assert.match(await page.getByTestId('modbus-data').innerText(), /ON \/ 1/); assert.equal(await label('寄存器数据显示').isDisabled(), true);
    await label('筛选 Modbus 数据').fill('off'); assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 8);
    await label('筛选 Modbus 数据').fill(''); await label('Modbus 数量').fill('2000'); await button('读取').click(); await waitDone();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length === 2000);
    assert.ok(await page.getByTestId('modbus-data').evaluate((el) => el.scrollHeight > el.clientHeight), 'maximum 2000-coil read stays in the bounded data scroller');
    await label('筛选 Modbus 数据').fill('on'); assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 1000);
    await label('Modbus 功能码').selectOption('3'); await label('Modbus 起始地址').fill('7');
    await label('Modbus 数量').fill('8');
    await label('Modbus 功能码').selectOption('4'); await label('按五位参考编号输入').check();
    assert.equal(await label('Modbus 起始地址').inputValue(), '30008');
    const beforeInvalid = await requestCount(); await label('Modbus 起始地址').fill('40001'); await button('读取').click();
    assert.equal(await requestCount(), beforeInvalid, 'wrong-area reference never reaches host');
    await label('Modbus 起始地址').fill('30001'); await label('按五位参考编号输入').uncheck();
    await label('Modbus 起始地址').fill('65535'); await label('Modbus 数量').fill('2'); await button('读取').click();
    assert.equal(await requestCount(), beforeInvalid, 'overflowing address range is rejected');
    await label('Modbus 起始地址').fill('0'); await label('Modbus 功能码').selectOption('6');
    await label('允许 Modbus 写入').check(); await label('Modbus 写入值').fill('0x1234'); await button('写入…').click();
    const dialog = page.getByRole('dialog', { name: '确认写入设备？' });
    assert.match(await dialog.innerText(), /Modbus TCP/); assert.match(await dialog.innerText(), /4660/);
    assert.equal(await label('Modbus 功能码').isDisabled(), true, 'confirmation freezes background function');
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((el) => el === document.activeElement), true, 'safe initial focus is cancel');
    await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.getByRole('button', { name: '关闭确认弹窗', exact: true }).evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.getByRole('button', { name: '确认写入', exact: true }).evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await dialog.getByRole('button', { name: '关闭确认弹窗', exact: true }).evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((el) => el === document.activeElement), true);
    for (const [width, height, textSize] of [[1280, 762, 'comfortable'], [1280, 762, 'large'], [760, 600, 'large']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, textSize);
      const box = await dialog.boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1, 'modal is centered in the entire client horizontally');
      assert.ok(Math.abs(box.y + box.height / 2 - height / 2) <= 1, 'modal is centered in the entire client vertically');
      assert.ok(box.x >= 15 && box.y >= 15 && box.x + box.width <= width - 15 && box.y + box.height <= height - 15, 'modal fits the client at each text size');
      assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true, 'confirmation has no horizontal scrollbar');
      await page.screenshot({ path: path.join(directory, `confirmation-${width}-${height}-${textSize}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
    assert.equal(await button('写入…').evaluate((el) => el === document.activeElement), true, 'cancel restores initiating focus');
    assert.equal(await requestCount(), beforeInvalid, 'keyboard cancellation never writes');
    await button('写入…').click(); await dialog.getByRole('button', { name: '确认写入', exact: true }).click(); await waitDone();
    assert.deepEqual((await lastRequest()).values, [4660]); assert.equal((await lastRequest()).confirmed, true);
    assert.equal(await label('轮询读取').isDisabled(), true, 'write operations cannot be polled');
    const beforeFailure = await requestCount();
    await page.evaluate(() => { window.__modbusFixture.failNextRequest = true; });
    await button('写入…').click(); await dialog.getByRole('button', { name: '确认写入', exact: true }).click();
    await page.getByText('Synthetic write timeout', { exact: true }).waitFor();
    await page.waitForTimeout(350);
    assert.equal(await requestCount(), beforeFailure + 1, 'failed write is never automatically retried');
    assert.equal(await dialog.count(), 0, 'failed write requires a new explicit confirmation rather than a retry dialog');
    await label('Modbus 功能码').selectOption('3'); await label('轮询间隔毫秒').fill('100');
    const beforePolling = await requestCount(); await label('轮询读取').check();
    await page.waitForFunction((before) => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').length >= before + 2, beforePolling);
    await label('轮询读取').uncheck(); await waitDone();
    const polled = await page.evaluate((before) => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').slice(before), beforePolling);
    assert.ok(polled.every((r) => r.payload.functionCode === 3 && !r.payload.confirmed), 'polling only issues unconfirmed read requests');
    assert.ok(await page.getByTestId('modbus-data').locator('tbody tr').count() > 0, 'stopping polling preserves last result');
    const beforeReadFailure = await requestCount();
    await page.evaluate(() => { window.__modbusFixture.failNextRequest = true; });
    await label('轮询读取').check(); await area().getByText('Synthetic write timeout', { exact: true }).waitFor();
    assert.equal(await label('轮询读取').isChecked(), false, 'a read bridge error disables automatic polling');
    await page.waitForTimeout(350); assert.equal(await requestCount(), beforeReadFailure + 1, 'a read bridge error never starts another automatic request');
    assert.ok(await page.getByTestId('modbus-data').locator('tbody tr').count() > 0, 'failed refresh keeps the last successful values readable');
    await button('展开报文').click();
    const log = area().getByRole('log', { name: 'Modbus 原始报文' }); const height = (await log.boundingBox()).height;
    await page.evaluate(() => { const f = window.__modbusFixture; for (let i = 0; i < 500; ++i) f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'RX', hex: '01 03 02 00 01 79 84', message: '' }); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Modbus 原始报文"]').children.length === 256);
    assert.equal((await log.boundingBox()).height, height, '500 raw frames do not expand the viewport');
    assert.ok(await log.evaluate((el) => el.scrollHeight > el.clientHeight), 'raw frames scroll internally');
    await log.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => { const f = window.__modbusFixture; f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'RX', hex: 'F0 0D', message: 'fresh frame' }); });
    await button('1 条新报文 · 查看最新').waitFor();
    assert.equal(await log.evaluate((el) => el.scrollTop), 0, 'new frames do not steal the historical scroll position');
    await button('1 条新报文 · 查看最新').click();
    assert.ok(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2), 'explicit latest control resumes following');
    await label('跟随 Modbus 最新报文').uncheck();
    await page.evaluate(() => { const f = window.__modbusFixture; f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'TX', hex: 'F0 0E', message: 'paused follow' }); });
    await button('1 条新报文 · 查看最新').waitFor();
    assert.match(await log.innerText(), /paused follow/, 'pause follow is not pause receive');
    await button('收起报文').click();
    await page.evaluate(() => { window.__modbusFixture.hold = true; }); await button('读取').click();
    await page.waitForFunction(() => window.__modbusFixture.snapshot.pending);
    await button('断开连接').click(); await button('连接设备').waitFor();
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 0, 'disconnect clears held operation result');
    await page.evaluate(() => { window.__modbusFixture.hold = false; });
    await label('Modbus 设备 ID').fill('2'); await button('连接设备').click(); await button('断开连接').waitFor(); await button('读取').click(); await waitDone();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length > 0);
    assert.equal(await page.getByTestId('modbus-data').locator('tr[data-changed]').count(), 0, 'a new device session starts a fresh baseline even for the same request range');
    assert.match(await page.getByTestId('modbus-result-context').innerText(), /ID 2/);
    await button('断开连接').click(); await button('连接设备').waitFor();
    await fit('completed-and-disconnected');
    for (const viewport of [{ width: 1024, height: 768 }, { width: 760, height: 600 }]) {
      await page.setViewportSize(viewport); await fit(`responsive-${viewport.width}`, false);
      await button('连接设备').scrollIntoViewIfNeeded();
      assert.ok((await button('连接设备').boundingBox()).width >= 80);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(nativeDialogs, [], 'all confirmations use the shared client dialog, not browser dialogs');
    console.log('PASS Modbus UI: results-first TCP/RTU layout, collapsed/expandable raw frames, both font sizes, 125-row internal table, no-blank refresh, scoped change baseline, address/HEX/signed/ON-OFF filtering and filtered clipboard, stale snapshots excluded but drained logs retained, pause/follow logs, reference bounds, centered immutable write confirmation/no automatic write retry, read-only single-flight polling. Synthetic host only.');
  } catch (error) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
