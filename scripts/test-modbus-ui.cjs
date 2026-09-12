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
    const f = window.__modbusFixture = { snapshot, requests: [], logs: [], clipboard: [], sequence: 0, generation: 0, hold: false };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => f.clipboard.push(text) } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = { addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener),
      postMessage: (request) => {
        f.requests.push(request);
        if (request.type === 'app.ready') { setTimeout(() => listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: { reminders: [], now: Date.now(), petName: '依依', characters: [], openLastView: true, lastDashboardView: 'toolbox', lastToolCategory: 'network', workspaceTheme: 'warm', workspaceTextSize: 'comfortable' } } })), 10); return; }
        if (!request.type.startsWith('modbus.')) return;
        const p = request.payload || {}, action = request.type.split('.')[1];
        let response;
        if (action === 'ports') response = { ports: ['COM3'] };
        else {
          if (action === 'start') Object.assign(snapshot, { state: 'connected', pending: false, unitId: p.unitId, transport: p.transport, endpoint: p.transport === 'tcp' ? `${p.host}:${p.port}` : p.serialPort, result: null, error: '' });
          if (action === 'stop') { ++f.generation; Object.assign(snapshot, { state: 'stopped', pending: false, result: null }); }
          if (action === 'request') {
            const generation = f.generation; Object.assign(snapshot, { pending: true, result: null, error: '' });
            if (!f.hold) setTimeout(() => {
              if (generation !== f.generation) return;
              const written = [5,6,15,16].includes(p.functionCode);
              snapshot.result = { id: ++f.sequence, functionCode: p.functionCode, address: p.address, quantity: p.quantity, values: written ? p.values : Array.from({ length: p.quantity }, (_, i) => i), written, timestamp: Date.now(), elapsedMs: 50 };
              snapshot.pending = false;
              f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'TX', hex: '01 03 00 00 00 08 44 0C', message: '' });
            }, 70);
          }
          response = { snapshot: { ...snapshot }, logs: action === 'poll' ? f.logs.splice(0) : [] };
        }
        setTimeout(() => listeners.forEach((listener) => listener({ data: { type: `${request.type}.result`, payload: { requestId: p.requestId, ...response } } })), 10);
      } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
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
    if (strict) assert.ok(main.scrollHeight <= main.height + 1, `${name}: default page stays fixed ${JSON.stringify(main)}`);
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18768/?mode=dashboard');
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Modbus 调试助手', exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
    for (const size of ['comfortable', 'large']) {
      await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
      for (const transport of ['Modbus TCP', 'Modbus RTU']) {
        await area().getByRole('tab', { name: transport, exact: true }).click();
        for (const code of ['3','16']) { await label('Modbus 功能码').selectOption(code); await fit(`${transport}-${code}-${size}-1280`); }
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await area().getByRole('tab', { name: 'Modbus TCP', exact: true }).click(); await label('Modbus 功能码').selectOption('3');
    await button('连接设备').click(); await button('断开连接').waitFor();
    await label('按五位参考编号输入').check(); assert.equal(await label('Modbus 起始地址').inputValue(), '40001');
    await label('Modbus 起始地址').fill('40008'); await button('读取').click(); await waitDone();
    assert.equal((await lastRequest()).address, 7);
    await label('按五位参考编号输入').uncheck(); assert.equal(await label('Modbus 起始地址').inputValue(), '7');
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
    await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.getByRole('button', { name: '确认写入', exact: true }).evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
    assert.equal(await button('写入…').evaluate((el) => el === document.activeElement), true, 'cancel restores initiating focus');
    assert.equal(await requestCount(), beforeInvalid, 'keyboard cancellation never writes');
    await button('写入…').click(); await dialog.getByRole('button', { name: '确认写入', exact: true }).click(); await waitDone();
    assert.deepEqual((await lastRequest()).values, [4660]); assert.equal((await lastRequest()).confirmed, true);
    assert.equal(await label('轮询读取').isDisabled(), true, 'write operations cannot be polled');
    await label('Modbus 功能码').selectOption('3'); await label('轮询间隔毫秒').fill('100');
    const beforePolling = await requestCount(); await label('轮询读取').check();
    await page.waitForFunction((before) => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').length >= before + 2, beforePolling);
    await label('轮询读取').uncheck(); await waitDone();
    const polled = await page.evaluate((before) => window.__modbusFixture.requests.filter((r) => r.type === 'modbus.request').slice(before), beforePolling);
    assert.ok(polled.every((r) => r.payload.functionCode === 3 && !r.payload.confirmed), 'polling only issues unconfirmed read requests');
    const log = area().getByRole('log', { name: 'Modbus 原始报文' }); const height = (await log.boundingBox()).height;
    await page.evaluate(() => { const f = window.__modbusFixture; for (let i = 0; i < 500; ++i) f.logs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'RX', hex: '01 03 02 00 01 79 84', message: '' }); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Modbus 原始报文"]').children.length === 256);
    assert.equal((await log.boundingBox()).height, height, '500 raw frames do not expand the viewport');
    assert.ok(await log.evaluate((el) => el.scrollHeight > el.clientHeight), 'raw frames scroll internally');
    await page.evaluate(() => { window.__modbusFixture.hold = true; }); await button('读取').click();
    await page.waitForFunction(() => window.__modbusFixture.snapshot.pending);
    await button('断开连接').click(); await button('连接设备').waitFor();
    assert.equal(await page.getByTestId('modbus-data').locator('tbody tr').count(), 0, 'disconnect clears held operation result');
    await fit('completed-and-disconnected');
    for (const viewport of [{ width: 1024, height: 768 }, { width: 760, height: 600 }]) {
      await page.setViewportSize(viewport); await fit(`responsive-${viewport.width}`, false);
      await button('连接设备').scrollIntoViewIfNeeded();
      assert.ok((await button('连接设备').boundingBox()).width >= 80);
    }
    assert.deepEqual(errors, []);
    console.log('PASS Modbus UI: TCP/RTU read/write layouts, reference conversion/bounds, frozen write confirmation and focus, read-only polling, fixed 500-frame log, stop cancellation. Synthetic host only.');
  } catch (error) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
