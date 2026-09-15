/** Unified TCP/UDP workbench regression. All bridge responses are synthetic.
 * No sockets are opened and no real LAN, multicast or device traffic is sent. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 762 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const stopped = { mode: 'tcp-client', state: 'stopped', localHost: '127.0.0.1', localPort: 0,
      remoteHost: '127.0.0.1', remotePort: 9000, peers: [], rxPackets: 0, rxBytes: 0, txPackets: 0, txBytes: 0, multicastJoined: false };
    const state = window.__networkFixture = { requests: [], clipboard: [], holdClipboard: false, clipboardWaiters: [], snapshot: { ...stopped }, queue: [], pending: [],
      failNextStart: '', failNextSend: '', sequence: 0, holdReady: false, holdTx: false, readyRemaining: 0,
      holdNextPollResponse: false, deferredPolls: [],
      peers: [{ id: 'synthetic-peer-a', address: '192.0.2.20', port: 52345 }, { id: 'synthetic-peer-b', address: '192.0.2.21', port: 52346 }] };
    state.releasePollResponses = () => state.deferredPolls.splice(0).forEach((event) => listeners.forEach((callback) => callback(event)));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { state.clipboard.push(String(text)); if (state.holdClipboard) await new Promise((resolve) => state.clipboardWaiters.push(resolve)); } } });
    const originalArrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () { return this.name === 'synthetic-delayed-read.bin' ? new Promise((_resolve, reject) => { state.rejectFileRead = reject; }) : originalArrayBuffer.call(this); };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, callback) => listeners.add(callback),
      removeEventListener: (_type, callback) => listeners.delete(callback),
      postMessage(request) {
        state.requests.push({ ...request, time: Date.now(), stateAtRequest: state.snapshot.state, pendingAtRequest: state.pending.length });
        if (!request.type.startsWith('network.')) return;
        const payload = request.payload || {};
        setTimeout(() => {
          let message = '', result;
          if (request.type === 'network.interfaces') result = { interfaces: [
            { name: 'Synthetic WLAN', address: '192.0.2.6', index: 42, loopback: false },
            { name: 'Loopback', address: '127.0.0.1', index: 1, loopback: true },
          ] };
          else if (request.type === 'network.start') {
            message = state.failNextStart; state.failNextStart = '';
            if (!message) {
              state.snapshot = { ...stopped, ...payload, localPort: payload.localPort || 52123, state: 'starting' };
              state.readyRemaining = 2; state.pending = []; state.queue = []; state.sequence = 0;
            }
            result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.stop') {
            state.snapshot = { ...state.snapshot, state: 'stopped', peers: [], lastError: '', multicastJoined: false };
            state.pending = []; result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.send') {
            message = state.failNextSend; state.failNextSend = '';
            if (!message && !['connected', 'listening', 'ready'].includes(state.snapshot.state)) message = 'Synthetic: transport is not ready';
            const server = state.snapshot.mode === 'tcp-server';
            const targets = server ? (payload.targetPeerId && payload.targetPeerId !== 'all'
              ? state.snapshot.peers.filter((peer) => peer.id === payload.targetPeerId) : state.snapshot.peers) : [{ id: '', address: state.snapshot.remoteHost, port: state.snapshot.remotePort }];
            if (!message && server && !targets.length) message = 'Synthetic: selected peer is no longer connected';
            if (!message) state.pending.push({ hex: payload.dataHex, targets: [...targets], polls: 3 });
            result = { snapshot: { ...state.snapshot } };
          } else {
            if (!state.holdReady && ['starting', 'connecting'].includes(state.snapshot.state) && --state.readyRemaining <= 0) {
              state.snapshot.state = state.snapshot.mode === 'tcp-server' ? 'listening' : state.snapshot.mode === 'udp' ? 'ready' : 'connected';
              state.snapshot.multicastJoined = !!state.snapshot.multicastGroup;
            }
            if (state.snapshot.state === 'listening') state.snapshot.peers = [...state.peers];
            if (!state.holdTx && state.pending.length && --state.pending[0].polls <= 0) {
              const entry = state.pending[0], peer = entry.targets.shift();
              state.snapshot.txPackets += 1; state.snapshot.txBytes += entry.hex.length / 2;
              state.queue.push({ id: ++state.sequence, kind: 'sent', timestamp: Date.now(), dataHex: entry.hex,
                peerId: peer.id, peerLabel: `${peer.address}:${peer.port}`, byteLength: entry.hex.length / 2 });
              if (entry.targets.length) entry.polls = 2;
              else state.pending.shift();
            }
            result = { snapshot: { ...state.snapshot }, events: state.queue.splice(0) };
          }
          const event = { data: { type: `${request.type}.${message ? 'error' : 'result'}`,
            payload: { requestId: payload.requestId, ...(message ? { message } : result) } } };
          if (request.type === 'network.poll' && state.holdNextPollResponse) {
            state.holdNextPollResponse = false; state.deferredPolls.push(event); return;
          }
          listeners.forEach((callback) => callback(event));
        }, 15);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const directory = path.resolve(__dirname, '../artifacts/network-debugger'); fs.mkdirSync(directory, { recursive: true });
  const workspace = () => page.getByTestId('network-workspace');
  const log = () => page.getByRole('log', { name: '网络收发记录', exact: true });
  const field = (name) => page.getByLabel(name, { exact: true });
  const button = (name) => workspace().getByRole('button', { name, exact: true });
  const count = (type) => page.evaluate((type) => window.__networkFixture.requests.filter((request) => request.type === type).length, type);
  const latest = (type) => page.evaluate((type) => window.__networkFixture.requests.filter((request) => request.type === type).at(-1), type);
  const waitIdle = () => page.waitForFunction(() => {
    const action = [...document.querySelectorAll('[data-testid="network-workspace"] button')].find((element) => element.textContent === '发送一次');
    return action && !action.disabled;
  });
  async function confirmExternal() {
    const dialog = page.getByRole('dialog', { name: '确认网络操作', exact: true });
    await dialog.waitFor(); await dialog.getByRole('button', { name: /^确认并/ }).click();
  }
  async function stop() {
    if (await button('停止 / 断开').isEnabled()) {
      await button('停止 / 断开').click();
      await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'stopped');
    }
  }
  async function openNetwork() {
    if (await workspace().count()) await workspace().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await page.getByRole('button', { name: /^工具首页/ }).click();
    assert.equal(await page.getByRole('heading', { name: '发包工具', exact: true }).count(), 0, 'standalone packet-sender entry is removed');
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '网络调试助手', exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click(); await workspace().waitFor();
    await field('发送网卡').selectOption('127.0.0.1');
  }
  async function box(locator) {
    return locator.evaluate((element) => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return {
      x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      contentHeight: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    }; });
  }
  async function screenshot(label) {
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: path.join(directory, `${label}-${width}x${height}.png`), fullPage: true });
  }
  async function injectRows(count, prefix) {
    await page.evaluate(({ count, prefix }) => {
      const fixture = window.__networkFixture;
      for (let index = 0; index < count; index++) {
        const bytes = new TextEncoder().encode(`${prefix} ${index}`);
        fixture.queue.push({ id: ++fixture.sequence, kind: 'received', timestamp: Date.now(), peerLabel: '192.0.2.20:9000',
          dataHex: [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''), byteLength: bytes.length });
        fixture.snapshot.rxBytes += bytes.length;
      }
      fixture.snapshot.rxPackets += count;
    }, { count, prefix });
    await page.waitForFunction((label) => document.querySelector('[aria-label="网络收发记录"]')?.textContent.includes(label), `${prefix} ${count - 1}`);
  }
  const modes = [
    { name: 'TCP 客户端', id: 'tcp-client', start: '连接服务', ready: 'connected' },
    { name: 'TCP 服务端', id: 'tcp-server', start: '开始监听', ready: 'listening' },
    { name: 'UDP', id: 'udp', start: '绑定端口', ready: 'ready' },
  ];
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard'); await openNetwork();
    assert.equal(await count('network.start'), 0, 'opening unified workbench is read-only');

    // Protocol tabs visibly identify the active mode and are a single keyboard
    // stop. Moving between tabs is still configuration, never a network action.
    const protocolTabs = page.getByRole('tablist', { name: '网络模式', exact: true });
    async function verifyProtocolTab(name) {
      const selected = page.getByRole('tab', { name, exact: true });
      assert.equal(await selected.getAttribute('aria-selected'), 'true');
      assert.equal(await selected.getAttribute('tabindex'), '0');
      assert.equal(await protocolTabs.locator('[role=tab][aria-selected=true]').count(), 1, 'one mode is selected');
      assert.equal(await protocolTabs.locator('[role=tab][tabindex="0"]').count(), 1, 'tablist has one roving keyboard stop');
      const colors = await protocolTabs.evaluate((element) => [...element.querySelectorAll('[role=tab]')].map((tab) => {
        const style = getComputedStyle(tab);
        return { selected: tab.getAttribute('aria-selected') === 'true', background: style.backgroundColor,
          foreground: style.color, border: style.borderColor, shadow: style.boxShadow, height: tab.getBoundingClientRect().height };
      }));
      const active = colors.find((tab) => tab.selected);
      assert.ok(active.height >= 38, 'mode switch retains a normal-sized hit area');
      for (const inactive of colors.filter((tab) => !tab.selected)) {
        assert.notEqual(active.background, inactive.background, 'selected mode has a distinct filled background');
        assert.ok(active.foreground !== inactive.foreground || active.border !== inactive.border || active.shadow !== inactive.shadow,
          'selected mode has a second visible distinction beyond background fill');
      }
    }
    const keyboardSequence = [['ArrowRight', 'TCP 服务端'], ['ArrowRight', 'UDP'], ['ArrowRight', 'TCP 客户端'],
      ['End', 'UDP'], ['ArrowLeft', 'TCP 服务端'], ['Home', 'TCP 客户端']];
    const stopBeforeKeyboard = await count('network.stop');
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).focus();
    for (const [key, name] of keyboardSequence) {
      await page.keyboard.press(key); await verifyProtocolTab(name);
      assert.equal(await page.getByRole('tab', { name, exact: true }).evaluate((element) => element === document.activeElement), true,
        'keyboard mode switch keeps focus on the selected tab');
    }
    assert.equal(await count('network.start'), 0, 'keyboard mode switching never connects');
    assert.equal(await count('network.send'), 0, 'keyboard mode switching never sends');
    assert.equal(await count('network.stop'), stopBeforeKeyboard, 'keyboard mode switching does not stop an absent session');

    // Connecting/listening is independent from packet editing and sending.
    for (const mode of modes) {
      await page.getByRole('tab', { name: mode.name, exact: true }).click();
      await field('报文内容').fill('');
      const sendBase = await count('network.send');
      await page.evaluate(() => { window.__networkFixture.holdReady = true; });
      await button(mode.start).click();
      await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'starting');
      assert.equal(await count('network.send'), sendBase, `${mode.name} starts with empty payload without sending`);
      await page.evaluate(() => { window.__networkFixture.holdReady = false; });
      await page.waitForFunction((ready) => window.__networkFixture.snapshot.state === ready, mode.ready);
      await page.waitForTimeout(200);
      assert.equal((await latest('network.start')).payload.mode, mode.id);
      assert.equal(await count('network.send'), sendBase, `${mode.name} ready state does not auto-send`);
      await field('报文内容').fill('云依\nfixture'); await field('行尾').selectOption('crlf');
      if (mode.id === 'tcp-server') await page.evaluate(() => { window.__networkFixture.holdTx = true; });
      await button('发送一次').click();
      if (mode.id === 'tcp-server') {
        await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, sendBase);
        await page.evaluate(() => {
          window.__networkFixture.peers.push({ id: 'synthetic-peer-late', address: '192.0.2.99', port: 52999 });
          window.__networkFixture.holdTx = false;
        });
      }
      await waitIdle();
      assert.equal((await latest('network.send')).payload.dataHex, Buffer.from('云依\nfixture\r\n').toString('hex'), `${mode.name}: UTF-8 and explicit CRLF are preserved`);
      if (mode.id === 'tcp-server') {
        const serverAll = await page.evaluate((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').slice(base), sendBase);
        assert.deepEqual(serverAll.map((request) => request.payload.targetPeerId), ['synthetic-peer-a', 'synthetic-peer-b'], 'server-all freezes existing peer IDs and sends individually');
        assert.equal(serverAll.some((request) => request.payload.targetPeerId === 'synthetic-peer-late'), false, 'a client joining mid-run is excluded from the frozen recipients');
        assert.ok(serverAll.every((request) => request.pendingAtRequest === 0), 'each peer waits for the previous actual TX before enqueueing');
        assert.equal(await page.evaluate(() => window.__networkFixture.snapshot.txPackets), 2, 'one server-all action waits for separate real TX acknowledgments from both fixture peers');
        await field('发送目标').selectOption('synthetic-peer-b');
        await button('发送一次').click(); await waitIdle();
        assert.equal((await latest('network.send')).payload.targetPeerId, 'synthetic-peer-b', 'chosen peer ID is submitted unchanged');
        assert.equal(await page.evaluate(() => window.__networkFixture.snapshot.txPackets), 3);
        await page.evaluate(() => { window.__networkFixture.peers = window.__networkFixture.peers.filter((peer) => peer.id !== 'synthetic-peer-late'); });
      }
      await stop(); await field('行尾').selectOption('none');
    }

    // Irrelevant remote fields left in a client draft must not block server
    // listening once those inputs are intentionally hidden by the mode switch.
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).click();
    await field('目标地址').fill(''); await field('目标端口').fill('0');
    await page.getByRole('tab', { name: 'TCP 服务端', exact: true }).click();
    const hiddenTargetSendBase = await count('network.send');
    await button('开始监听').click();
    await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'listening');
    assert.equal(await count('network.send'), hiddenTargetSendBase, 'hidden invalid target does not block receive-only server startup');
    await stop();
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).click();
    await field('目标地址').fill('127.0.0.1'); await field('目标端口').fill('9000');

    // The merged library also preserves server mode and line endings, while
    // loading saved settings remains entirely free of socket operations.
    await page.getByRole('tab', { name: 'TCP 服务端', exact: true }).click();
    await field('报文内容').fill('saved server content');
    await field('行尾').selectOption('crlf'); await field('发包本地端口').fill('6655');
    const savesStartBase = await count('network.start'), savesSendBase = await count('network.send');
    await button('另存为模板').click(); await field('模板名称').fill('Saved server fixture');
    await page.getByRole('dialog', { name: '报文模板', exact: true }).getByRole('button', { name: '保存模板', exact: true }).click();
    await page.getByRole('dialog', { name: '报文模板', exact: true }).getByRole('button', { name: '完成', exact: true }).click();
    await button('清空内容').click(); await button('报文模板').click();
    await page.getByTestId('packet-library').getByRole('button', { name: '应用到发送区', exact: true }).click();
    await page.getByRole('dialog', { name: '报文模板', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '报文内容');
    assert.equal(await page.getByRole('tab', { name: 'TCP 服务端', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await field('行尾').inputValue(), 'crlf'); assert.equal(await field('发包本地端口').inputValue(), '6655');
    assert.equal(await field('报文内容').inputValue(), 'saved server content');
    assert.equal(await count('network.start'), savesStartBase); assert.equal(await count('network.send'), savesSendBase);
    await field('行尾').selectOption('none');

    // The same centered permission flow applies to explicit listening; cancelling
    // it never changes the current session, and confirmation sends no payload.
    await page.getByRole('tab', { name: 'TCP 服务端', exact: true }).click();
    await field('发送网卡').selectOption('0.0.0.0');
    const broadStartBase = await count('network.start'), broadSendBase = await count('network.send');
    await button('开始监听').click();
    const consent = page.getByRole('dialog', { name: '确认网络操作', exact: true }); await consent.waitFor();
    const modal = await box(consent), viewport = page.viewportSize();
    assert.ok(Math.abs((modal.x + modal.right) / 2 - viewport.width / 2) < 2, 'network consent is centered across the entire client');
    await consent.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await count('network.start'), broadStartBase); assert.equal(await count('network.send'), broadSendBase);
    await button('开始监听').click(); await confirmExternal();
    await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'listening');
    assert.equal((await latest('network.start')).payload.allowLan, true);
    assert.equal(await count('network.send'), broadSendBase);
    await stop(); await field('发送网卡').selectOption('127.0.0.1');

    // TCP server retains targeted and all-peer sends, and rejects stale peers.
    await button('开始监听').click();
    await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'listening');
    await field('报文内容').fill('server fixture'); await field('发送目标').selectOption('synthetic-peer-a');
    const peerRunSendBase = await count('network.send'), peerRunStopBase = await count('network.stop');
    await field('重发次数').fill('3');
    await page.evaluate(() => { window.__networkFixture.holdTx = true; }); await button('重复发送').click();
    await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, peerRunSendBase);
    await page.evaluate(() => { window.__networkFixture.peers = window.__networkFixture.peers.filter((peer) => peer.id !== 'synthetic-peer-a'); });
    await page.evaluate(() => { window.__networkFixture.holdTx = false; }); await waitIdle();
    await page.waitForFunction(() => window.__networkFixture.snapshot.peers.length === 1);
    await page.waitForTimeout(200);
    assert.equal(await count('network.send'), peerRunSendBase + 1, 'a selected peer disconnect stops the rest of its batch');
    assert.equal(await count('network.stop'), peerRunStopBase, 'one disconnected peer does not stop the entire server');
    assert.equal(await page.evaluate(() => window.__networkFixture.snapshot.state), 'listening');
    assert.equal(await page.evaluate(() => window.__networkFixture.snapshot.peers[0].id), 'synthetic-peer-b', 'other client stays connected');
    const absentPeerBase = await count('network.send');
    assert.equal(await field('发送目标').inputValue(), 'synthetic-peer-a', 'a disconnected selected peer is not silently replaced by all remaining clients');
    assert.ok((await field('发送目标').innerText()).includes('断开'), 'disconnected selected peer remains visibly marked');
    if (await button('发送一次').isEnabled()) await button('发送一次').click();
    await page.waitForTimeout(200);
    assert.equal(await count('network.send'), absentPeerBase, 'disconnected selected peer cannot enqueue a send to other clients');
    await page.evaluate(() => { window.__networkFixture.peers = []; });
    await page.waitForFunction(() => window.__networkFixture.snapshot.peers.length === 0);
    if (await button('发送一次').isEnabled()) await button('发送一次').click();
    assert.equal(await count('network.send'), absentPeerBase, 'empty peer list cannot enqueue an ambiguous server send');
    await stop();
    await page.evaluate(() => { window.__networkFixture.peers = [{ id: 'synthetic-peer-a', address: '192.0.2.20', port: 52345 }, { id: 'synthetic-peer-b', address: '192.0.2.21', port: 52346 }]; });

    // Native startup failure never becomes a successful receive-only connection.
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).click();
    await page.evaluate(() => { window.__networkFixture.failNextStart = 'Synthetic connection denied'; });
    const sendsBeforeStartFailure = await count('network.send');
    await button('连接服务').click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic connection denied' }).waitFor();
    assert.equal(await count('network.send'), sendsBeforeStartFailure);
    assert.notEqual(await page.evaluate(() => window.__networkFixture.snapshot.state), 'connected');
    const connectionError = () => workspace().getByRole('alert').filter({ hasText: 'Synthetic connection denied' });
    await field('报文内容').fill('editing must not hide connection failure');
    assert.ok(await connectionError().isVisible(), 'editing payload preserves the unrelated connection error');
    await button('清空内容').click(); assert.ok(await connectionError().isVisible(), 'clearing payload preserves connection failure');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: 'HEX', exact: true }).click();
    assert.ok(await connectionError().isVisible(), 'changing payload encoding preserves connection failure');
    await field('发送内容文件').setInputFiles({ name: 'local-fixture.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([65, 66]) });
    await page.waitForFunction(() => document.querySelector('[aria-label="报文内容"]')?.value === '41 42');
    assert.ok(await connectionError().isVisible(), 'loading local payload bytes preserves connection failure');
    await field('发送内容文件').setInputFiles({ name: 'synthetic-delayed-read.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([65]) });
    await page.waitForFunction(() => typeof window.__networkFixture.rejectFileRead === 'function');
    await field('报文内容').fill('43 44');
    await page.evaluate(() => { window.__networkFixture.rejectFileRead(new Error('stale file read failure')); });
    await page.waitForTimeout(50);
    assert.equal(await field('报文内容').inputValue(), '43 44', 'old file reads cannot replace a newly edited payload');
    assert.equal(await workspace().getByRole('alert').filter({ hasText: 'stale file read failure' }).count(), 0, 'late file failures cannot overwrite a newer draft error state');
    const copyButton = page.getByTestId('packet-sender-results').getByRole('button', { name: '复制', exact: true });
    await copyButton.click();
    assert.ok(await connectionError().isVisible(), 'successful copy feedback does not clear connection failure');
    // A clipboard request may resolve after a different connection attempt fails.
    // Its completion may only clear its own log-copy error, never the new failure.
    await page.evaluate(() => { window.__networkFixture.holdClipboard = true; }); await copyButton.click();
    await page.waitForFunction(() => window.__networkFixture.clipboardWaiters.length === 1);
    await page.evaluate(() => { window.__networkFixture.failNextStart = 'Synthetic later connection denied'; });
    await button('连接服务').click();
    await workspace().getByRole('alert').filter({ hasText: 'Synthetic later connection denied' }).waitFor();
    await page.evaluate(() => { const state = window.__networkFixture; state.holdClipboard = false; state.clipboardWaiters.splice(0).forEach((resolve) => resolve()); });
    await page.waitForTimeout(60);
    assert.ok(await workspace().getByRole('alert').filter({ hasText: 'Synthetic later connection denied' }).isVisible(), 'late clipboard completion cannot erase a newer connection error');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: '文本', exact: true }).click();

    // Finite and continuous repeat modes never queue ahead of actual TX. Stopping
    // just a run keeps its socket alive for ongoing receives and another send.
    await page.getByRole('tab', { name: 'UDP', exact: true }).click();
    await field('目标地址').fill('127.0.0.1'); await field('目标端口').fill('9000');
    await field('报文内容').fill('serial fixture'); await field('重发间隔').fill('100'); await field('重发次数').fill('3');
    await button('绑定端口').click(); await page.waitForFunction(() => window.__networkFixture.snapshot.state === 'ready');
    const finiteBase = await count('network.send');
    await page.evaluate(() => { window.__networkFixture.holdTx = true; }); await button('重复发送').click();
    await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, finiteBase);
    await page.waitForTimeout(350); assert.equal(await count('network.send'), finiteBase + 1, 'finite repeats wait for real TX');
    await page.evaluate(() => { window.__networkFixture.holdTx = false; }); await waitIdle();
    assert.equal(await count('network.send'), finiteBase + 3);
    const finiteStopBase = await count('network.send'), finiteStopCalls = await count('network.stop');
    await page.evaluate(() => { window.__networkFixture.holdTx = true; }); await button('重复发送').click();
    await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, finiteStopBase);
    await button('停止发送').click();
    await page.evaluate(() => { window.__networkFixture.holdTx = false; }); await waitIdle(); await page.waitForTimeout(400);
    assert.equal(await count('network.send'), finiteStopBase + 1, 'stop-run cancels the remaining finite count');
    assert.equal(await count('network.stop'), finiteStopCalls, 'finite stop-run also preserves the socket');
    const startsBeforeContinuous = await count('network.start'), stopsBeforeContinuous = await count('network.stop'), continuousBase = await count('network.send');
    await page.evaluate(() => { window.__networkFixture.holdTx = true; }); await button('持续发送').click();
    await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, continuousBase);
    assert.ok(await field('报文内容').isDisabled(), 'continuous-run content is frozen');
    await page.waitForTimeout(350); assert.equal(await count('network.send'), continuousBase + 1, 'continuous mode also waits for TX');
    await button('停止发送').click();
    await page.evaluate(() => { window.__networkFixture.holdTx = false; }); await waitIdle();
    await page.waitForTimeout(800);
    assert.equal(await count('network.send'), continuousBase + 1, 'stop-run invalidates all future continuous sends');
    assert.equal(await count('network.stop'), stopsBeforeContinuous, 'stop-run does not disconnect');
    assert.equal(await page.evaluate(() => window.__networkFixture.snapshot.state), 'ready');
    await button('发送一次').click(); await waitIdle();
    assert.equal(await count('network.start'), startsBeforeContinuous, 'subsequent manual send reuses preserved socket');
    const recent = await page.evaluate((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').slice(base), finiteBase);
    assert.ok(recent.every((request) => request.pendingAtRequest === 0), 'no finite/continuous/manual send overtakes previous queued TX');

    // A background poll may already have drained real traffic when a new send
    // generation starts. Its late reply must retain events, not stale snapshots.
    const beforeLatePollSend = await count('network.send');
    await page.evaluate(() => {
      const fixture = window.__networkFixture;
      fixture.holdNextPollResponse = true;
      fixture.queue.push({ id: ++fixture.sequence, kind: 'received', timestamp: Date.now(),
        peerLabel: 'synthetic-late-poll', message: 'retained drained event during new run', byteLength: 0 });
    });
    await page.waitForFunction(() => window.__networkFixture.deferredPolls.length === 1);
    await button('发送一次').click();
    await page.waitForFunction((base) => window.__networkFixture.requests.filter((request) => request.type === 'network.send').length > base, beforeLatePollSend);
    await page.evaluate(() => { window.__networkFixture.releasePollResponses(); }); await waitIdle();
    assert.ok((await log().innerText()).includes('retained drained event during new run'), 'late drained traffic survives generation changes');

    // Console styling must not steal focus or scroll history out from under a reader.
    const beforeLog = await box(log()); await injectRows(500, 'synthetic-history');
    assert.equal((await box(log())).height, beforeLog.height, '500 events never grow the console');
    assert.ok((await box(log())).scrollHeight > (await box(log())).clientHeight, 'history scrolls internally');
    const timestamps = field('显示时间'); assert.equal(await timestamps.isChecked(), true);
    assert.ok(await log().locator('time').count() > 0, 'timestamps are displayed as semantic time elements');
    await timestamps.uncheck(); assert.equal(await log().locator('time').count(), 0, 'time toggle hides all row times');
    await timestamps.check();
    await log().evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await field('报文内容').focus();
    const scrollBefore = await log().evaluate((element) => element.scrollTop); await injectRows(1, 'synthetic-new-tail');
    assert.equal(await log().evaluate((element) => element.scrollTop), scrollBefore, 'incoming data preserves reader position away from bottom');
    assert.equal(await field('报文内容').evaluate((element) => element === document.activeElement), true, 'new rows do not steal editing focus');
    await button('查看最新数据').click();
    assert.ok(await log().evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 5), 'new-data action explicitly returns to the tail');
    await page.getByTestId('packet-sender-results').getByRole('button', { name: '复制', exact: true }).click();
    assert.match(await page.evaluate(() => window.__networkFixture.clipboard.at(-1)), /synthetic-new-tail/);
    await screenshot('unified-history-reader'); await stop();

    // All modes share one responsive workbench. Compact windows may scroll
    // vertically; hiding or shrinking controls to fit is deliberately not a goal.
    for (const [width, height] of [[1280, 762], [1920, 1040], [1024, 640], [760, 560]]) {
      await page.setViewportSize({ width, height });
      for (const size of ['comfortable', 'large']) {
        await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
        for (const mode of modes) {
          await page.getByRole('tab', { name: mode.name, exact: true }).click();
          await verifyProtocolTab(mode.name);
          const main = page.getByRole('main').last(); await main.evaluate((element) => { element.scrollTop = 0; });
          await page.getByTestId('network-operations').evaluate((element) => { element.scrollTop = 0; });
          const outer = await box(main), left = await box(page.getByTestId('packet-sender-editor')), right = await box(page.getByTestId('packet-sender-results'));
          assert.ok(outer.scrollWidth <= outer.clientWidth + 1, `${mode.name}/${width}/${size}: no horizontal page overflow`);
          assert.ok((await box(log())).contentHeight >= 319, `${mode.name}/${width}/${size}: log retains 320 usable pixels`);
          assert.ok(await page.getByTestId('packet-library-panel').isHidden(), 'closed templates reserve no permanent results panel');
          assert.equal(await page.getByTestId('packet-sender-results').getByTestId('packet-library-panel').count(), 0);
          for (const control of [field('行尾'), field('重发间隔'), field('重发次数'), button('发送一次'), button('重复发送'), button('持续发送'), button('停止 / 断开')]) {
            assert.ok(await control.evaluate((element) => !!element.closest('[data-testid="network-operations"]')),
              'line ending, repeat settings and every send/stop action belong to the left scroll area');
          }
          if (width > 900) assert.ok(right.x >= left.right + 8 && Math.abs(right.y - left.y) < 2, 'desktop aligns editing and results side by side');
          else assert.ok(right.y >= left.bottom, 'only narrow views stack');
          if (width === 1280 && height === 762 && size === 'comfortable' && mode.id !== 'tcp-server') {
            const editor = await box(field('报文内容')), parameters = await box(page.getByTestId('network-operations'));
            const visibleEditorHeight = Math.min(editor.bottom, parameters.bottom, height) - Math.max(editor.y, parameters.y, 0);
            assert.ok(visibleEditorHeight >= 100, `${mode.name}: default non-multicast view exposes at least 100px of payload without scrolling, got ${visibleEditorHeight}`);
          }
          for (const control of [button(mode.start), field('报文内容'), field('行尾'), button('持续发送')]) {
            await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
            const rect = await box(control);
            assert.ok(rect.x >= 0 && rect.right <= width + 1 && rect.y >= -1 && rect.bottom <= height + 1, 'all normal-size controls remain reachable through natural scroll');
          }
          await page.getByTestId('network-operations').evaluate((element) => { element.scrollTop = 0; });
          await main.evaluate((element) => { element.scrollTop = 0; });
          if (size === 'comfortable') await screenshot(`unified-${mode.id}-${size}`);
        }
      }
    }
    assert.deepEqual(errors, [], 'no uncaught application exceptions');
    console.log('PASS: unified entry; high-contrast roving TCP client/server/UDP tabs with arrows/Home/End and no automatic network effects; receive-only startup; hidden server target fields; centered consent/cancel; UTF-8/CRLF and server template restore/focus; frozen all/single/stale peers; disconnected-peer batch stops while other clients stay connected; late drained poll events retained; serial finite/continuous sends with stop-run preserving session; readable logs/time/manual scroll/focus/new-data jump; no permanent right template panel; all send options scroll inside the left operations; responsive split/stack layouts. All network bridge traffic is synthetic.');
  } catch (error) {
    await screenshot('failure').catch(() => {}); throw error;
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
