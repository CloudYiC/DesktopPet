/** Network layout regression with a synthetic WebView2 bridge. Never opens a socket,
 * starts a real listener, sends traffic, or touches the operating-system clipboard. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const stopped = { mode: 'tcp-client', state: 'stopped', localHost: '127.0.0.1', localPort: 0,
      remoteHost: '127.0.0.1', remotePort: 9000, peers: [], rxPackets: 0, rxBytes: 0, txPackets: 0, txBytes: 0 };
    const state = window.__networkFixture = { requests: [], clipboard: [], snapshot: { ...stopped }, queue: [], failNextStart: '', failNextSend: '', sequence: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => state.clipboard.push(String(text)),
    } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        state.requests.push(request);
        if (!request.type.startsWith('network.')) return;
        const payload = request.payload || {};
        setTimeout(() => {
          let message = '';
          let response;
          if (request.type === 'network.start') {
            message = state.failNextStart; state.failNextStart = '';
            if (!message) state.snapshot = { ...stopped, ...payload,
              state: payload.mode === 'tcp-server' ? 'listening' : payload.mode === 'udp' ? 'ready' : 'connected',
              peers: payload.mode === 'tcp-server' ? [{ id: 'synthetic-peer', address: '192.0.2.20', port: 52345 }] : [] };
            response = { snapshot: state.snapshot };
          } else if (request.type === 'network.stop') {
            state.snapshot = { ...state.snapshot, state: 'stopped', peers: [], lastError: '' };
            response = { snapshot: state.snapshot };
          } else if (request.type === 'network.send') {
            message = state.failNextSend; state.failNextSend = '';
            if (!message) {
              state.snapshot.txPackets += 1; state.snapshot.txBytes += payload.dataHex.length / 2;
              state.queue.push({ id: ++state.sequence, kind: 'sent', timestamp: Date.now(), dataHex: payload.dataHex,
                peerLabel: 'synthetic only', byteLength: payload.dataHex.length / 2 });
            }
            response = { snapshot: state.snapshot };
          } else response = { snapshot: state.snapshot, events: state.queue.splice(0) };
          const event = { data: { type: `${request.type}.${message ? 'error' : 'result'}`,
            payload: { requestId: payload.requestId, ...(message ? { message } : response) } } };
          listeners.forEach((listener) => listener(event));
        }, 30);
      },
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const directory = path.resolve(__dirname, '../artifacts/network-debugger');
  fs.mkdirSync(directory, { recursive: true });
  const header = () => page.locator('header[aria-label="工具详情导航"]');
  const workspace = () => header().locator('..');
  const operation = () => workspace().locator('[class*="operationColumn"]');
  const sendPanel = () => workspace().locator('section[class*="sendPanel"]');
  const receivePanel = () => workspace().locator('section[class*="receivePanel"]');
  const log = () => page.getByRole('log', { name: '网络收发记录', exact: true });
  const main = () => page.getByRole('main').last();
  const field = (name) => ['本地地址', '行尾', '发送目标'].includes(name)
    ? workspace().locator('label').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${name}$`) }) }).locator('select')
    : page.getByLabel(name, { exact: true });
  const button = (name) => name === '发送' ? sendPanel().getByRole('button', { name: /^发送\s/ }) : page.getByRole('button', { name, exact: true });
  const modes = [
    { name: 'TCP 客户端', id: 'tcp-client', start: '连接服务', stop: '断开连接' },
    { name: 'TCP 服务端', id: 'tcp-server', start: '开始监听', stop: '停止监听' },
    { name: 'UDP', id: 'udp', start: '绑定端口', stop: '解除绑定' },
  ];
  async function openNetwork() {
    if (await header().count()) await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await page.getByRole('button', { name: /^⌂ 工具首页/ }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '网络调试助手', exact: true }) });
    const enable = card.getByRole('button', { name: 'Enable', exact: true });
    if (await enable.count()) await enable.click();
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).waitFor();
  }
  async function metrics(locator) {
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height, width: rect.width,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        overflowY: style.overflowY, overflowX: style.overflowX, fontSize: parseFloat(style.fontSize) };
    });
  }
  async function verifyDesktopLayout(mode, size) {
    const viewport = page.viewportSize();
    const outer = await metrics(main());
    const column = await metrics(operation());
    const frame = await metrics(workspace());
    assert.ok(outer.scrollHeight <= outer.clientHeight + 1, `${mode.name} ${size} ${viewport.width}×${viewport.height}: no unnecessary page vertical scroll ${JSON.stringify(outer)}`);
    assert.ok(column.scrollHeight <= column.clientHeight + 1, `${mode.name} ${size}: operation column does not need a scrollbar ${JSON.stringify(column)}`);
    assert.ok(outer.scrollWidth <= outer.clientWidth + 1, 'no horizontal page overflow');
    assert.ok(frame.bottom <= viewport.height + 1, 'workspace fits the default client height');
    const line = await metrics(field('行尾'));
    const cycle = await metrics(field('循环发送间隔毫秒'));
    assert.ok(Math.abs(line.y - cycle.y) <= 3, `${mode.name}: line ending and repeat interval share a row`);
    assert.ok(line.right <= cycle.x + 1, `${mode.name}: line ending precedes the repeat interval`);
    if (mode.id === 'tcp-server') {
      const target = await metrics(field('发送目标'));
      assert.ok(Math.abs(target.y - line.y) >= 30, 'TCP server target has its own row');
    }
    const fontFactor = size === 'large' ? 17 : 16;
    for (const label of ['本地地址', '本地端口', ...(mode.id !== 'tcp-server' ? ['远端主机', '远端端口'] : [])]) {
      const control = await metrics(field(label));
      assert.ok(control.height >= 38, `${label} keeps its 38px control height`);
      assert.ok(control.fontSize >= fontFactor * .75 - .02, `${label} preserves the existing type size`);
    }
    for (const label of [mode.start, '发送']) {
      const control = await metrics(button(label));
      assert.ok(control.height >= 40, `${label} retains its 40px button height`);
      assert.ok(control.bottom <= viewport.height + 1, `${label} is visible inside the client`);
    }
    assert.equal(await workspace().getByRole('heading', { name: '连接设置', exact: true }).count(), 0, 'redundant connection title is removed');
    const text = await workspace().innerText();
    for (const removed of ['所有连接和数据都只在当前电脑中处理。', '连接远端 TCP 服务并双向收发数据。', '监听本地端口并管理多个客户端。', '绑定本地端口并向指定目标发送数据报。']) {
      assert.equal(text.includes(removed), false, `removed boilerplate: ${removed}`);
    }
  }
  async function screen(label) {
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: path.join(directory, `${label}-${width}x${height}.png`), fullPage: true });
  }
  const requestCount = (type) => page.evaluate((type) => window.__networkFixture.requests.filter((request) => request.type === type).length, type);
  async function alertMatches(pattern) {
    await page.getByRole('alert').filter({ hasText: pattern }).waitFor();
    assert.ok(await page.getByRole('alert').filter({ hasText: pattern }).isVisible());
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    for (const [width, height] of [[1280, 800], [1280, 720], [1600, 900]]) {
      await page.setViewportSize({ width, height });
      for (const size of ['comfortable', 'large']) {
        await openNetwork();
        await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
        for (const mode of modes) {
          await page.getByRole('tab', { name: mode.name, exact: true }).click();
          await verifyDesktopLayout(mode, size); await screen(`${mode.id}-${size}`);
        }
      }
    }

    await page.setViewportSize({ width: 1280, height: 800 }); await openNetwork();
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    for (const mode of modes) {
      await page.getByRole('tab', { name: mode.name, exact: true }).click();
      await field('本地地址').selectOption('0.0.0.0');
      const allow = page.getByRole('checkbox', { name: mode.id === 'tcp-client' ? /允许外部网络连接/ : /允许局域网访问/ });
      await allow.waitFor(); assert.equal(await allow.isChecked(), false);
      assert.ok(await button(mode.start).isDisabled(), `${mode.name} requires explicit broad-interface consent`);
      const before = await requestCount('network.start');
      await allow.check(); await button(mode.start).click(); await button(mode.stop).waitFor();
      assert.equal(await requestCount('network.start'), before + 1);
      const request = await page.evaluate(() => window.__networkFixture.requests.filter((entry) => entry.type === 'network.start').at(-1));
      assert.equal(request.payload.allowLan, true); assert.equal(request.payload.mode, mode.id);
      await field('发送内容').fill('云依\nfixture'); await field('行尾').selectOption('crlf');
      await button('发送').click();
      await page.waitForFunction(() => window.__networkFixture.snapshot.txPackets > 0);
      const sent = await page.evaluate(() => window.__networkFixture.requests.filter((entry) => entry.type === 'network.send').at(-1));
      assert.equal(sent.payload.dataHex, Buffer.from('云依\nfixture\r\n').toString('hex'));
      if (mode.id === 'tcp-server') {
        await field('发送目标').selectOption('synthetic-peer'); await button('发送').click();
        await page.waitForFunction(() => window.__networkFixture.requests.filter((entry) => entry.type === 'network.send').at(-1)?.payload.targetPeerId === 'synthetic-peer');
      }
      await button(mode.stop).click(); await button(mode.start).waitFor();
    }

    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).click();
    await field('本地地址').selectOption('');
    await field('远端端口').fill('70000'); await button('连接服务').click(); await alertMatches(/端口/);
    await field('远端端口').fill('9000');
    await page.evaluate(() => { window.__networkFixture.failNextStart = '模拟连接失败（仅合成测试）'; });
    await button('连接服务').click(); await alertMatches(/模拟连接失败/);
    await button('连接服务').click(); await button('断开连接').waitFor();
    await page.evaluate(() => { window.__networkFixture.failNextSend = '模拟发送失败（仅合成测试）'; });
    await button('发送').click(); await alertMatches(/模拟发送失败/);
    const beforeLog = await metrics(log());
    const beforeReceive = await metrics(receivePanel());
    await page.evaluate(() => {
      const state = window.__networkFixture;
      for (let index = 0; index < 500; index += 1) state.queue.push({ id: ++state.sequence, kind: 'received', timestamp: Date.now(),
        byteLength: 32, peerLabel: '192.0.2.20:9000', message: `合成记录 ${index} — 此测试没有网络连接。` });
      state.snapshot.rxPackets += 500; state.snapshot.rxBytes += 16000;
    });
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent.includes('合成记录 499'));
    const afterLog = await metrics(log()); const afterReceive = await metrics(receivePanel());
    assert.equal(afterLog.height, beforeLog.height, '500 log events do not increase the log viewport height');
    assert.equal(afterReceive.height, beforeReceive.height, 'log growth does not resize the receive panel');
    assert.ok(afterLog.scrollHeight > afterLog.clientHeight, 'received data scrolls inside the log');
    assert.equal(afterLog.overflowY, 'auto');
    await log().evaluate((element) => { element.scrollTop = 0; });
    await receivePanel().getByRole('button', { name: '复制', exact: true }).click();
    assert.match(await page.evaluate(() => window.__networkFixture.clipboard.at(-1)), /合成记录 499/);
    await screen('received-500-records');
    await button('断开连接').click();

    await page.setViewportSize({ width: 760, height: 560 }); await openNetwork();
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'large'; });
    await page.getByRole('tab', { name: 'TCP 服务端', exact: true }).click();
    const small = await metrics(main());
    assert.ok(small.scrollHeight > small.clientHeight, 'a genuinely short/narrow window may scroll naturally');
    assert.ok(['auto', 'scroll'].includes(small.overflowY), 'small-window overflow is not hidden');
    await button('发送').scrollIntoViewIfNeeded();
    assert.ok((await metrics(button('发送'))).bottom <= 561, 'send action remains reachable in a small client');
    await field('行尾').selectOption('lf'); assert.equal(await field('行尾').inputValue(), 'lf');
    await screen('small-natural-scroll');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS: 3 modes × 3 desktop sizes × 2 typography preferences; same-row line/repeat controls; separate server target; unchanged control sizes; no unnecessary desktop scroll; small-window natural scroll; LAN consent, endpoint/start/send errors, UTF-8/CRLF sends, peer targeting, and 500 internal log rows.');
    console.log(`Screenshots: ${directory}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
