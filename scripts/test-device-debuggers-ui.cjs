/** Isolated UI regression. Every device and clipboard call is synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function addFixture(context) {
  await context.addInitScript(() => {
    const listeners = new Set();
    const serial = { state: 'stopped', port: '', baud: 115200, dataBits: 8, parity: 0, stopBits: 0, flowControl: 0, rxBytes: 0, txBytes: 0, lastError: '' };
    const mqtt = { state: 'stopped', brokerHost: '127.0.0.1', brokerPort: 1883, clientId: 'cloudyi-01', tls: false, sessionPresent: false, subscriptions: [], rxMessages: 0, rxBytes: 0, txMessages: 0, txBytes: 0, lastError: '' };
    const modbus = { state: 'stopped', transport: 'tcp', pending: false, error: '', result: null };
    const f = window.__deviceFixture = { requests: [], clipboard: [], serial, mqtt, modbus, serialEvents: [], mqttEvents: [], modbusLogs: [], sequence: 0, fail: '' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
      if (f.clipboardFailure) throw new Error('Synthetic clipboard denied');
      f.clipboard.push(text);
    } } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_name, listener) => listeners.add(listener),
      removeEventListener: (_name, listener) => listeners.delete(listener),
      postMessage: (request) => {
        f.requests.push(request);
        if (request.type === 'app.ready') {
          const state = { reminders: [], now: Date.now(), petName: '可爱依依', soundEnabled: false, speechEnabled: false, autoHideEnabled: false, autoHideMinutes: 10, characters: [], activeCharacterId: 'builtin', workspaceTheme: 'warm', workspaceTextSize: 'comfortable', openLastView: true, lastDashboardView: 'toolbox', lastToolCategory: 'network' };
          setTimeout(() => listeners.forEach((listener) => listener({ data: { type: 'state.sync', payload: state } })), 10);
          return;
        }
        const [prefix, action] = request.type.split('.');
        if (!['serial', 'mqtt', 'modbus'].includes(prefix)) return;
        const p = request.payload || {};
        setTimeout(() => {
          let result = {}, error = '';
          if (f.fail && !['poll', 'ports', 'enumerate', 'stop'].includes(action)) { error = f.fail; f.fail = ''; }
          else if (prefix === 'serial') {
            if (action === 'enumerate') result = { ports: [{ port: 'COM3', label: 'Synthetic COM3' }] };
            else {
              if (action === 'start') Object.assign(serial, p, { state: 'open', lastError: '' });
              if (action === 'stop') serial.state = 'stopped';
              if (action === 'send') { serial.txBytes += p.dataHex.length / 2; f.serialEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'tx', dataHex: p.dataHex, byteLength: p.dataHex.length / 2, message: '' }); }
              result = { snapshot: { ...serial }, events: action === 'poll' ? f.serialEvents.splice(0) : [] };
            }
          } else if (prefix === 'mqtt') {
            if (action === 'start') Object.assign(mqtt, { state: 'connected', brokerHost: p.host, brokerPort: p.port, clientId: p.clientId, tls: p.tls });
            if (action === 'stop') { mqtt.state = 'stopped'; mqtt.subscriptions = []; }
            if (action === 'subscribe') mqtt.subscriptions = [...mqtt.subscriptions.filter((sub) => sub.topic !== p.topic), { topic: p.topic, qos: p.qos }];
            if (action === 'unsubscribe') mqtt.subscriptions = mqtt.subscriptions.filter((sub) => sub.topic !== p.topic);
            if (action === 'publish') { mqtt.txMessages++; mqtt.txBytes += p.dataHex.length / 2; f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'published', topic: p.topic, qos: p.qos, retain: p.retain, payloadHex: p.dataHex, byteLength: p.dataHex.length / 2 }); }
            result = { snapshot: { ...mqtt }, events: action === 'poll' ? f.mqttEvents.splice(0) : [] };
          } else {
            if (action === 'ports') result = { ports: ['COM3'] };
            else {
              if (action === 'start') Object.assign(modbus, { state: 'connected', transport: p.transport, unitId: p.unitId, endpoint: p.transport === 'tcp' ? `${p.host}:${p.port}` : p.serialPort, result: null, error: '' });
              if (action === 'stop') Object.assign(modbus, { state: 'stopped', pending: false, result: null });
              if (action === 'request') {
                const write = [5, 6, 15, 16].includes(p.functionCode);
                if (write && p.confirmed !== true) error = '写入缺少确认';
                else {
                  const values = write ? p.values : Array.from({ length: p.quantity }, (_, i) => p.functionCode <= 2 ? i % 2 : i === 1 ? 65535 : (i + 1) * 25);
                  modbus.result = { id: ++f.sequence, functionCode: p.functionCode, address: p.address, quantity: p.quantity, values, timestamp: Date.now(), elapsedMs: 24, written: write };
                  f.modbusLogs.push({ id: ++f.sequence, timestamp: Date.now(), direction: 'TX', hex: '00 01 00 00 00 06 01 03 00 00 00 08', message: '' });
                }
              }
              result = { snapshot: { ...modbus }, logs: action === 'poll' ? f.modbusLogs.splice(0) : [] };
            }
          }
          const deliver = () => listeners.forEach((listener) => listener({ data: { type: `${request.type}.${error ? 'error' : 'result'}`, payload: { requestId: p.requestId, ...(error ? { message: error } : result) } } }));
          if (prefix === 'mqtt' && action === 'poll' && f.holdNextMqttPoll) {
            f.holdNextMqttPoll = false;
            f.heldMqttPoll = true;
            f.releaseMqttPoll = () => { f.heldMqttPoll = false; deliver(); };
          } else deliver();
        }, 20);
      },
    };
  });
}

module.exports = { addFixture };

if (require.main === module) (async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await addFixture(context);
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const directory = path.resolve(__dirname, '../artifacts/device-debuggers'); fs.mkdirSync(directory, { recursive: true });
  const header = () => page.locator('header[aria-label="工具详情导航"]');
  const main = () => page.getByRole('main').last();
  async function open(name) { await page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: '打开', exact: true }).click(); await header().getByRole('heading', { name, exact: true }).waitFor(); }
  async function back() { await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click(); }
  async function count(type) { return page.evaluate((type) => window.__deviceFixture.requests.filter((request) => request.type === type).length, type); }
  async function fit(id, suffix) {
    const frame = await page.getByTestId(id).boundingBox();
    const viewport = page.viewportSize();
    assert.ok(frame.x >= 180 && frame.x + frame.width <= viewport.width + 1, `${id}: no horizontal viewport overflow`);
    if (id === 'serial-workspace' && viewport.width >= 1024 && viewport.height >= 768) assert.ok(frame.y + frame.height <= viewport.height + 1, `${id}: default workspace fits vertically`);
    const geometry = await main().evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.width + 1, `${id}: no outer horizontal scrollbar`);
    if (id === 'serial-workspace') {
      const controls = page.getByTestId('serial-controls');
      const logPanel = await page.getByTestId('serial-log-panel').boundingBox();
      const left = await controls.boundingBox();
      const send = await page.getByRole('region', { name: '串口发送数据', exact: true }).getByRole('button', { name: /^发送/ }).boundingBox();
      const log = page.getByRole('log', { name: '串口收发记录', exact: true });
      assert.ok(await log.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'serial log has no horizontal overflow');
      assert.ok(await controls.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'serial controls have no horizontal overflow');
      if (viewport.width > 900) {
        assert.ok(logPanel.x >= left.x + left.width, 'serial receive log is right of connection and send controls');
        assert.ok(Math.abs(logPanel.y - left.y) <= 1, 'serial columns align at the top');
        assert.ok(frame.y + frame.height <= viewport.height + 1, 'serial whole workspace remains fixed to viewport');
        const outer = await main().evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
        assert.ok(outer.scroll <= outer.height + 1, 'serial desktop workspace does not require page scrolling');
        if (viewport.width >= 1280 && viewport.height >= 762) {
          assert.ok(send.y + send.height <= viewport.height, 'serial send action and receive log are simultaneously visible');
          assert.ok(await controls.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'normal serial controls fit without scrolling');
        }
      } else {
        assert.ok(logPanel.y >= left.y + left.height, 'only narrow windows stack the serial sections');
      }
    }
    await page.screenshot({ path: path.join(directory, `${id}-${suffix}.png`), fullPage: true, animations: 'disabled' });
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18768/?mode=dashboard');
    await open('串口调试助手');
    const serial = page.getByTestId('serial-workspace');
    await page.getByLabel('串口', { exact: true }).selectOption('COM3');
    await page.evaluate(() => { window.__deviceFixture.fail = '模拟串口打开失败'; });
    await serial.getByRole('button', { name: '打开串口', exact: true }).click();
    await page.getByTestId('serial-connection-feedback').filter({ hasText: '模拟串口打开失败' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '串口连接参数', exact: true }).getByRole('alert').count(), 1, 'serial connection errors stay in connection card');
    assert.equal(await page.getByTestId('serial-send-feedback').count(), 0, 'connection failure is not dumped into send controls');
    await page.getByLabel('波特率', { exact: true }).selectOption('57600');
    assert.ok((await page.getByTestId('serial-connection-feedback').innerText()).includes('模拟串口打开失败'), 'native serial error stays readable while correcting settings');
    await page.getByLabel('波特率', { exact: true }).selectOption('115200');
    await serial.getByRole('button', { name: '打开串口', exact: true }).click();
    await serial.getByRole('button', { name: '关闭串口', exact: true }).waitFor();
    assert.equal(await page.getByLabel('波特率', { exact: true }).isDisabled(), true);
    const sendArea = page.getByRole('region', { name: '串口发送数据', exact: true });
    await page.getByLabel('串口行尾', { exact: true }).selectOption('cr');
    await sendArea.getByRole('button', { name: /^发送/ }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'serial.send'));
    assert.equal(await page.evaluate(() => window.__deviceFixture.requests.find((request) => request.type === 'serial.send').payload.dataHex), '48454c4c4f0d');
    const beforeInvalid = await count('serial.send');
    await sendArea.getByRole('button', { name: 'HEX', exact: true }).click();
    await page.getByLabel('串口发送内容').fill('0G');
    assert.equal(await sendArea.getByRole('alert').count(), 1, 'serial HEX validation stays beside sending controls');
    assert.equal(await sendArea.getByRole('button', { name: /^发送/ }).isDisabled(), true);
    assert.equal(await count('serial.send'), beforeInvalid);
    await page.getByLabel('串口发送内容').fill('00 ff 0a');
    await sendArea.getByRole('button', { name: /^发送/ }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'serial.send' && request.payload.dataHex === '00ff0a'));
    const serialLog = page.getByRole('log', { name: '串口收发记录', exact: true });
    const serialHeight = (await serialLog.boundingBox()).height;
    await page.evaluate(() => { const f = window.__deviceFixture; for (let i = 0; i < 500; ++i) f.serialEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'rx', dataHex: '4f4b', byteLength: 2, message: '' }); });
    await page.waitForFunction(() => document.querySelector('[aria-label="串口收发记录"]').scrollHeight > document.querySelector('[aria-label="串口收发记录"]').clientHeight);
    assert.ok(Math.abs((await serialLog.boundingBox()).height - serialHeight) <= 1, 'serial log stays fixed after 500 records');
    await page.evaluate(() => { window.__deviceFixture.clipboardFailure = true; });
    await page.getByTestId('serial-log-panel').getByRole('button', { name: '复制', exact: true }).click();
    await page.getByTestId('serial-record-feedback').waitFor();
    assert.equal(await page.getByTestId('serial-log-panel').getByRole('alert').count(), 1, 'serial clipboard failures appear beside records, not send controls');
    await page.evaluate(() => { window.__deviceFixture.clipboardFailure = false; });
    await page.getByTestId('serial-log-panel').getByRole('button', { name: '复制', exact: true }).click();
    await page.getByTestId('action-toast').filter({ hasText: '收发记录已复制' }).waitFor();
    assert.equal(await page.getByTestId('serial-record-feedback').count(), 0);
    assert.ok(Math.abs((await serialLog.boundingBox()).height - serialHeight) <= 1, 'serial successful copy uses an overlay without changing log height');
    await page.getByRole('button', { name: '关闭操作提示' }).click();
    await fit('serial-workspace', '1280-connected');
    for (const size of [{ width: 1920, height: 1040 }, { width: 1280, height: 762 }, { width: 1024, height: 640 }, { width: 920, height: 762 }, { width: 760, height: 650 }]) {
      await page.setViewportSize(size);
      for (const font of ['comfortable', 'large']) {
        await page.evaluate((font) => { document.documentElement.dataset.workspaceTextSize = font; }, font);
        await fit('serial-workspace', `${size.width}x${size.height}-${font}`);
      }
    }
    await page.setViewportSize({ width: 1024, height: 640 });
    await serial.getByRole('button', { name: /高级设置/ }).click();
    assert.equal(await serial.getByLabel('DTR', { exact: true }).isVisible(), true);
    await fit('serial-workspace', '1024x640-expanded');
    await serial.getByRole('button', { name: /高级设置/ }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await back(); await page.waitForFunction(() => window.__deviceFixture.serial.state === 'stopped');

    await open('Modbus 调试助手');
    const modbus = page.getByTestId('modbus-workspace');
    await modbus.getByRole('button', { name: '连接设备', exact: true }).click();
    await modbus.getByRole('button', { name: '断开连接', exact: true }).waitFor();
    await modbus.getByRole('button', { name: '读取', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length === 8);
    await page.getByLabel('寄存器数据显示').selectOption('signed');
    assert.ok((await page.getByTestId('modbus-data').innerText()).includes('-1'), 'signed register conversion');
    const beforeWrite = await count('modbus.request');
    await page.getByLabel('Modbus 功能码').selectOption('6');
    assert.equal(await modbus.getByRole('button', { name: '写入…', exact: true }).isDisabled(), true);
    await page.getByLabel('允许 Modbus 写入').check();
    await page.getByLabel('Modbus 写入值').fill('123');
    await modbus.getByRole('button', { name: '写入…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认写入设备？' }); await dialog.waitFor();
    assert.equal(await count('modbus.request'), beforeWrite, 'opening confirmation never sends a write');
    assert.ok((await dialog.innerText()).includes('123'));
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await count('modbus.request'), beforeWrite, 'cancel never writes');
    await modbus.getByRole('button', { name: '写入…', exact: true }).click();
    await dialog.getByRole('button', { name: '确认写入', exact: true }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'modbus.request' && request.payload.confirmed === true));
    const write = await page.evaluate(() => window.__deviceFixture.requests.find((request) => request.type === 'modbus.request' && request.payload.confirmed === true).payload);
    assert.equal(write.functionCode, 6); assert.equal(write.address, 0); assert.deepEqual(write.values, [123]);
    await page.getByLabel('Modbus 功能码').selectOption('3');
    await modbus.getByRole('button', { name: '读取', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="modbus-data"] tbody tr').length === 8);
    await fit('modbus-workspace', '1280-connected');
    await back(); await page.waitForFunction(() => window.__deviceFixture.modbus.state === 'stopped');

    await open('MQTT 调试助手');
    const mqtt = page.getByTestId('mqtt-workspace');
    const publishArea = page.getByRole('region', { name: 'MQTT 发布', exact: true });
    await page.getByLabel('MQTT 发布内容').press('Control+Enter');
    assert.equal(await count('mqtt.publish'), 0, 'keyboard shortcut cannot publish before connection');
    await page.getByLabel('MQTT Broker 地址', { exact: true }).fill('');
    await mqtt.getByRole('button', { name: '连接 Broker', exact: true }).click();
    await page.getByTestId('mqtt-connection-feedback').waitFor();
    assert.equal(await page.getByRole('region', { name: 'MQTT 连接参数', exact: true }).getByRole('alert').count(), 1, 'local broker validation has a real scoped error style');
    await page.getByLabel('MQTT Broker 地址', { exact: true }).fill('127.0.0.1');
    await mqtt.getByRole('button', { name: '连接 Broker', exact: true }).click();
    await mqtt.getByRole('button', { name: '断开连接', exact: true }).waitFor();
    assert.equal(await page.getByLabel('MQTT Broker 地址', { exact: true }).isDisabled(), true);
    await page.getByLabel('MQTT 订阅主题').fill('devices/#/state');
    await mqtt.getByRole('button', { name: '订阅', exact: true }).click();
    assert.equal(await count('mqtt.subscribe'), 0, 'invalid wildcard filter never reaches native host');
    assert.equal(await page.getByRole('region', { name: 'MQTT 订阅', exact: true }).getByRole('alert').count(), 1, 'local MQTT subscription validation is a scoped error, not green status');
    assert.equal(await page.getByTestId('mqtt-connection-feedback').count(), 0, 'subscription validation does not masquerade as connection failure');
    await page.getByLabel('MQTT 订阅主题').fill('devices/+/state');
    await page.getByLabel('订阅 QoS', { exact: true }).selectOption('2');
    await mqtt.getByRole('button', { name: '订阅', exact: true }).click();
    await page.getByLabel('取消订阅 devices/+/state').waitFor();
    await page.getByLabel('MQTT 发布主题').fill('devices/+/set');
    await publishArea.getByRole('button', { name: /^发布/ }).click();
    assert.equal(await count('mqtt.publish'), 0, 'wildcards are not legal publish topics');
    assert.equal(await publishArea.getByRole('alert').count(), 1, 'publish-topic validation is adjacent to publishing');
    await page.getByLabel('MQTT 发布主题').fill('devices/demo/set');
    await page.getByLabel('发布 QoS', { exact: true }).selectOption('2');
    await publishArea.getByLabel('Retain', { exact: true }).check();
    await publishArea.getByRole('button', { name: 'HEX', exact: true }).click();
    await page.getByLabel('MQTT 发布内容').fill('0G');
    assert.equal(await publishArea.getByRole('button', { name: /^发布/ }).isDisabled(), true);
    await page.getByLabel('MQTT 发布内容').fill('00 ff 0a');
    await publishArea.getByRole('button', { name: /^发布/ }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'mqtt.publish'));
    const publication = await page.evaluate(() => window.__deviceFixture.requests.find((request) => request.type === 'mqtt.publish').payload);
    assert.equal(publication.dataHex, '00ff0a'); assert.equal(publication.qos, 2); assert.equal(publication.retain, true);
    const messages = page.getByRole('listbox', { name: 'MQTT 消息列表', exact: true });
    await messages.getByRole('option').first().waitFor();
    assert.equal(await page.getByTestId('mqtt-detail').count(), 0, 'receiving or publishing does not automatically open a detail panel');
    await messages.getByRole('option').first().click();
    await page.getByRole('region', { name: 'MQTT 消息', exact: true }).getByRole('button', { name: 'HEX', exact: true }).click();
    assert.equal(await page.getByLabel('消息内容', { exact: true }).innerText(), '00 FF 0A');
    // Empty retained payloads are valid MQTT publications and must not look unselected.
    await page.getByLabel('MQTT 发布内容').fill('');
    await publishArea.getByRole('button', { name: /^发布/ }).click();
    await page.waitForFunction(() => window.__deviceFixture.requests.some((request) => request.type === 'mqtt.publish' && request.payload.dataHex === ''));
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="MQTT 消息列表"] [role="option"]').length === 2);
    await page.getByRole('button', { name: '收起消息详情', exact: true }).click();
    await messages.getByRole('option').last().click();
    assert.ok(!(await page.getByLabel('消息内容', { exact: true }).innerText()).includes('选择'), 'empty payload remains a selected message');
    const messageHeight = (await messages.boundingBox()).height;
    await page.evaluate(() => { const f = window.__deviceFixture; for (let i = 0; i < 500; ++i) f.mqttEvents.push({ id: ++f.sequence, timestamp: Date.now(), kind: 'message', topic: `devices/unit${i}/state`, qos: 1, retain: false, payloadHex: '4f4b', byteLength: 2 }); });
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="MQTT 消息列表"] [role="option"]').length === 502);
    assert.ok(Math.abs((await messages.boundingBox()).height - messageHeight) <= 1, 'MQTT list stays fixed after 500 records');
    assert.ok(await messages.evaluate((el) => el.scrollHeight > el.clientHeight), 'MQTT messages scroll internally');
    await page.getByLabel('筛选 MQTT 消息').fill('unit499');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="MQTT 消息列表"] [role="option"]').length === 1);
    await messages.getByRole('option').first().click();
    assert.equal(await page.getByLabel('消息内容', { exact: true }).innerText(), '4F 4B');
    await page.getByLabel('筛选 MQTT 消息').fill('');
    await page.getByLabel('取消订阅 devices/+/state').click();
    await page.waitForFunction(() => window.__deviceFixture.mqtt.subscriptions.length === 0);
    await fit('mqtt-workspace', '1280-connected');
    // Feedback is partitioned by operation: ongoing polls/other commands cannot
    // erase it. None of these synthetic failures changes message layout or IO.
    await page.getByLabel('MQTT 订阅主题').fill('invalid/#/filter');
    await mqtt.getByRole('button', { name: '订阅', exact: true }).click();
    await page.getByTestId('mqtt-subscription-feedback').waitFor();
    await page.getByLabel('MQTT 发布主题').fill('bad/+/publish');
    await publishArea.getByRole('button', { name: /^发布/ }).click();
    await page.getByTestId('mqtt-publish-feedback').waitFor();
    await page.evaluate(() => { window.__deviceFixture.mqtt.lastError = '模拟持续连接错误'; });
    await page.getByTestId('mqtt-connection-feedback').filter({ hasText: '模拟持续连接错误' }).waitFor();
    const scopedErrorCount = await mqtt.getByRole('alert').count();
    assert.equal(scopedErrorCount, 3, 'polling errors preserve the independent subscription and publish errors');
    await page.getByLabel('筛选 MQTT 消息').fill('unit499');
    await messages.getByRole('option').first().click();
    await page.evaluate(() => { window.__deviceFixture.clipboardFailure = true; });
    await page.getByTestId('mqtt-detail').getByRole('button', { name: '复制', exact: true }).click();
    await page.getByTestId('mqtt-copy-feedback').waitFor();
    assert.equal(await page.getByTestId('mqtt-detail').getByRole('alert').count(), 1, 'MQTT copy failures are local to selected details');
    assert.equal(await page.getByTestId('mqtt-controls').getByRole('alert').count(), 3, 'copy failures do not overwrite left-card errors');
    await page.evaluate(() => { window.__deviceFixture.clipboardFailure = false; });
    await page.getByTestId('mqtt-detail').getByRole('button', { name: '复制', exact: true }).click();
    await page.getByTestId('action-toast').filter({ hasText: '消息内容已复制' }).waitFor();
    assert.equal(await page.getByTestId('mqtt-copy-feedback').count(), 0);
    const pollBeforeFeedbackCheck = await count('mqtt.poll');
    await page.getByLabel('筛选 MQTT 消息').focus();
    await page.waitForFunction((before) => window.__deviceFixture.requests.filter((request) => request.type === 'mqtt.poll').length > before + 2, pollBeforeFeedbackCheck);
    assert.equal(await page.getByLabel('筛选 MQTT 消息').evaluate((el) => document.activeElement === el), true, 'polling an existing error never steals keyboard focus');
    assert.equal(await page.getByTestId('mqtt-controls').getByRole('alert').count(), 3, 'subsequent poll does not remove another operation error');
    await fit('mqtt-workspace', 'scoped-errors-and-toast');
    await back(); await page.waitForFunction(() => window.__deviceFixture.mqtt.state === 'stopped');
    await page.evaluate(() => { window.__deviceFixture.mqtt.lastError = ''; });
    for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 760, height: 700 }]) {
      await page.setViewportSize(size);
      for (const [name, id] of [['串口调试助手', 'serial-workspace'], ['MQTT 调试助手', 'mqtt-workspace'], ['Modbus 调试助手', 'modbus-workspace']]) {
        await open(name); await fit(id, `${size.width}-initial`); await back();
        if (size.width === 1280) {
          await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'large'; });
          await open(name); await fit(id, `${size.width}-large`); await back();
          await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
        }
      }
    }
    assert.deepEqual(errors, [], 'no unhandled React/browser errors');
    console.log('PASS: serial byte preparation/fixed logs, MQTT QoS/binary/empty Retain payloads/subscriptions/filtering/fixed logs, Modbus reads/write confirmation, desktop-only cleanup and responsive layouts. All communication is synthetic.');
  } catch (error) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
