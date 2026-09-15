/** Unified network workspace: retained packet-library/multicast regression. All network.* messages are handled in
 * this page fixture: no sockets, LAN/multicast packets, devices or real clipboard. */
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
    const state = window.__packetFixture = { requests: [], clipboard: [], snapshot: { ...stopped }, queue: [], pending: [],
      failNextStart: '', failNextSend: '', failJoinOnReady: '', readyDelayPolls: 3, txDelayPolls: 3, readyRemaining: 0,
      holdReady: false, holdTx: false, sequence: 0,
      interfaces: [{ name: 'Synthetic WLAN', address: '192.0.2.6', index: 42, loopback: false },
        { name: 'Synthetic Ethernet', address: '198.51.100.9', index: 77, loopback: false },
        { name: 'Loopback', address: '127.0.0.1', index: 1, loopback: true }] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => state.clipboard.push(String(value)) } });
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
          if (request.type === 'network.interfaces') {
            result = { interfaces: state.interfaces };
          } else if (request.type === 'network.start') {
            message = state.failNextStart; state.failNextStart = '';
            if (!message) {
              state.snapshot = { ...stopped, ...payload, localPort: payload.localPort || 52123, state: 'starting' };
              state.readyRemaining = state.readyDelayPolls; state.pending = []; state.queue = []; state.sequence = 0;
            }
            result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.stop') {
            state.snapshot = { ...state.snapshot, state: 'stopped', lastError: '', multicastJoined: false }; state.pending = [];
            result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.send') {
            message = state.failNextSend; state.failNextSend = '';
            if (!message && !['ready', 'connected', 'listening'].includes(state.snapshot.state)) message = 'Synthetic: send before transport ready';
            if (!message) state.pending.push({ hex: payload.dataHex, polls: state.txDelayPolls });
            result = { snapshot: { ...state.snapshot } };
          } else {
            if (!state.holdReady && (state.snapshot.state === 'starting' || state.snapshot.state === 'connecting')) {
              if (--state.readyRemaining <= 0) {
                if (state.snapshot.multicastGroup && state.failJoinOnReady) {
                  state.snapshot.state = 'error'; state.snapshot.lastError = state.failJoinOnReady; state.failJoinOnReady = '';
                } else {
                  state.snapshot.state = state.snapshot.mode === 'udp' ? 'ready' : state.snapshot.mode === 'tcp-server' ? 'listening' : 'connected';
                  state.snapshot.multicastJoined = !!state.snapshot.multicastGroup;
                }
              }
              else if (state.snapshot.mode === 'tcp-client') state.snapshot.state = 'connecting';
            }
            if (!state.holdTx && state.pending.length) {
              const entry = state.pending[0];
              if (--entry.polls <= 0) {
                state.pending.shift(); state.snapshot.txPackets += 1; state.snapshot.txBytes += entry.hex.length / 2;
                state.queue.push({ id: ++state.sequence, kind: 'sent', timestamp: Date.now(), dataHex: entry.hex,
                  byteLength: entry.hex.length / 2, peerLabel: `${state.snapshot.remoteHost}:${state.snapshot.remotePort}` });
              }
            }
            result = { snapshot: { ...state.snapshot }, events: state.queue.splice(0) };
          }
          const event = { data: { type: `${request.type}.${message ? 'error' : 'result'}`, payload: {
            requestId: payload.requestId, ...(message ? { message } : result),
          } } };
          listeners.forEach((callback) => callback(event));
        }, 15);
      },
    };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const directory = path.resolve(__dirname, '../artifacts/packet-sender-ui'); fs.mkdirSync(directory, { recursive: true });
  const workspace = () => page.getByTestId('network-workspace');
  const field = (name) => page.getByLabel(name, { exact: true });
  const button = (name) => workspace().getByRole('button', { name, exact: true });
  const templateDialog = () => page.getByRole('dialog', { name: '报文模板', exact: true });
  const templateButton = (name) => templateDialog().getByRole('button', { name, exact: true });
  const openTemplates = async () => {
    await button('报文模板').click(); await templateDialog().waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索模板');
  };
  const closeTemplates = async () => {
    await templateButton('关闭报文模板').click(); await templateDialog().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '报文模板');
  };
  const log = () => page.getByRole('log', { name: '网络收发记录', exact: true });
  const count = (type) => page.evaluate((type) => window.__packetFixture.requests.filter((request) => request.type === type).length, type);
  const request = (type) => page.evaluate((type) => window.__packetFixture.requests.filter((entry) => entry.type === type).at(-1), type);
  const waitEnabled = () => button('发送一次').waitFor({ state: 'visible' }).then(() => page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[data-testid="network-workspace"] button')].find((element) => element.textContent === '发送一次');
    return button && !button.disabled;
  }));
  const stop = async () => { if (await button('停止 / 断开').isEnabled()) { await button('停止 / 断开').click(); await waitEnabled(); } };
  const consentDialog = () => page.getByRole('dialog', { name: '确认网络操作', exact: true });
  async function confirmExternal(action = '发送') {
    await consentDialog().waitFor();
    await consentDialog().getByRole('button', { name: action === '加入' ? '确认并加入' : '确认并发送', exact: true }).click();
  }
  async function openTool() {
    await page.getByRole('button', { name: /^工具首页/ }).click();
    assert.equal(await page.getByRole('heading', { name: '发包工具', exact: true }).count(), 0, 'there is no duplicate standalone packet-sender card');
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '网络调试助手', exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click(); await workspace().waitFor();
  }
  async function box(locator) {
    return locator.evaluate((element) => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return {
      x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      contentHeight: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    }; });
  }
  async function verifyReadableLayout(width, height, scenario) {
    const main = page.getByRole('main').last();
    await main.evaluate((element) => { element.scrollTop = 0; });
    const outer = await box(main), left = await box(page.getByTestId('packet-sender-editor')),
      right = await box(page.getByTestId('packet-sender-results')), consoleBounds = await box(log());
    assert.ok(outer.scrollWidth <= outer.clientWidth + 1, `${scenario}: no horizontal page scrollbar`);
    assert.ok(consoleBounds.contentHeight >= 319, `${scenario}: log text has at least 320px of usable height, excluding padding`);
    if (width > 900) {
      assert.ok(right.x >= left.right + 8 && Math.abs(right.y - left.y) <= 2, `${scenario}: editing and results remain aligned side by side`);
      if (right.bottom > height + 1) {
        assert.ok(outer.scrollHeight > outer.clientHeight, `${scenario}: an outer scrollbar permits taller results instead of clipping them`);
      }
    } else assert.ok(right.y >= left.bottom, `${scenario}: only narrow windows use a natural stack`);
    assert.ok((await box(field('报文内容'))).height >= 110, `${scenario}: payload editor is not squeezed`);
    const footer = page.getByTestId('packet-sender-results').locator('footer');
    await footer.scrollIntoViewIfNeeded();
    assert.ok((await box(footer)).bottom <= height + 1, `${scenario}: log footer is reachable through normal vertical scrolling`);
    assert.ok((await box(log())).contentHeight >= 319, `${scenario}: scrolling does not collapse the log`);
    await main.evaluate((element) => { element.scrollTop = 0; });
  }
  const saved = (name, id) => ({ id, updatedAt: '2026-09-14T00:00:00.000Z', name, protocol: 'udp', host: '127.0.0.1', port: 9000,
    localAddress: '127.0.0.1', localPort: 0, dataMode: 'hex', payload: '00 ff 41', intervalMs: 150, repeatCount: 3 });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard'); await openTool();
    await page.waitForTimeout(400);
    assert.equal(await count('network.start'), 0, 'opening the tool never establishes a session');
    assert.equal(await count('network.send'), 0, 'opening the tool never sends');
    assert.ok(await count('network.interfaces') > 0, 'opening reads available adapters without opening a socket');
    assert.ok((await field('发送网卡').innerText()).includes('Synthetic WLAN'), 'available Windows adapter name and IPv4 are visible');
    await field('发送网卡').selectOption('127.0.0.1');

    // Editing, local templates and file loading have no native network effects.
    await field('报文内容').fill('云依😀');
    assert.equal(await page.getByTestId('packet-byte-count').innerText(), '10 字节', 'UTF-8 byte count is not character count');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: 'HEX', exact: true }).click();
    assert.equal((await field('报文内容').inputValue()).replace(/\s/g, '').toLowerCase(), Buffer.from('云依😀').toString('hex'));
    await field('报文内容').fill('00 ff 41');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: '转义字节', exact: true }).click();
    assert.ok((await field('报文内容').inputValue()).toLowerCase().includes('\\ff'), 'binary 0xff remains a byte in escaped mode');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: 'HEX', exact: true }).click();
    assert.equal((await field('报文内容').inputValue()).replace(/\s/g, '').toLowerCase(), '00ff41', 'binary mode roundtrip is lossless');
    await field('报文内容').fill('0 ff');
    assert.ok(await button('发送一次').isDisabled(), 'odd HEX digits cannot be sent');
    await field('报文内容').fill('');
    if (await button('发送一次').isEnabled()) await button('发送一次').click();
    assert.equal(await count('network.start'), 0, 'empty content is rejected before native startup');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: 'HEX', exact: true }).click();
    await field('报文内容').fill('00 ff 41'); await field('模板名称').fill('Fixture alpha');
    await button('保存模板').click();
    assert.ok(await page.getByTestId('packet-library-panel').isHidden(), 'saving never opens a permanent right-hand library');
    assert.equal(await page.getByTestId('packet-sender-results').getByTestId('packet-library-panel').count(), 0);
    await openTemplates();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 1);
    await closeTemplates(); await button('新建').click(); await openTemplates();
    await templateButton('载入').click(); await templateDialog().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '报文内容');
    assert.equal(await field('报文内容').inputValue(), '00 ff 41', 'saved template loads without loss');
    await button('更新模板').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cloudyi.packet-sender.library.v1')).packets.length), 1,
      'updating a loaded template replaces its ID instead of duplicating it');
    await openTemplates(); await templateButton('删除模板 Fixture alpha').click();
    const dialog = page.getByRole('dialog', { name: '删除报文模板？' }); await dialog.waitFor();
    const modal = await box(dialog), viewport = page.viewportSize();
    assert.ok(Math.abs((modal.x + modal.right) / 2 - viewport.width / 2) < 2, 'delete confirmation is centered in the entire client');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '删除模板 Fixture alpha');
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 1, 'cancel preserves the template');
    await templateButton('删除模板 Fixture alpha').click(); await dialog.getByRole('button', { name: '删除模板', exact: true }).click();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索模板');
    await field('模板导入文件').setInputFiles({ name: 'packets.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: [saved('Imported fixture', 'fixture-import')] })) });
    await page.getByTestId('packet-library').getByRole('article').first().waitFor();
    await templateButton('载入').click(); await templateDialog().waitFor({ state: 'hidden' });
    assert.equal(await field('模板名称').inputValue(), 'Imported fixture');
    assert.equal(await field('发送网卡').inputValue(), '127.0.0.1', 'legacy 0.13.6 template retains its explicit local binding');
    const libraryBeforeInvalidImport = await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1'));
    await openTemplates();
    await field('模板导入文件').setInputFiles({ name: 'invalid.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: [{ ...saved('Invalid', 'invalid-import'), autoSend: true }] })) });
    await templateDialog().getByRole('alert').waitFor();
    const errorRect = await box(templateDialog().getByRole('alert'));
    assert.ok(errorRect.y >= 0 && errorRect.bottom <= page.viewportSize().height, 'import validation is visible in the open centered dialog');
    assert.equal(await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1')), libraryBeforeInvalidImport,
      'unknown imported fields are rejected without overwriting saved templates');
    await closeTemplates();
    await field('发送内容文件').setInputFiles({ name: 'fixture.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 65]) });
    await page.waitForTimeout(50); assert.equal(await field('报文内容').inputValue(), '00 ff 41');
    assert.equal(await count('network.start'), 0, 'save, load, delete, import and binary file load do not connect');
    assert.equal(await count('network.send'), 0, 'all template operations are side-effect free');

    // UDP/TCP wait for asynchronous readiness and actual TX, not enqueue replies.
    await button('发送一次').click(); await waitEnabled();
    assert.equal(await count('network.send'), 1);
    assert.equal((await request('network.send')).stateAtRequest, 'ready');
    assert.equal((await request('network.send')).payload.dataHex, '00ff41');
    assert.ok((await log().innerText()).includes('TX →'), 'native completion appears in the receive log');
    await page.getByRole('tab', { name: 'TCP 客户端', exact: true }).click(); await field('目标端口').fill('9010');
    await button('发送一次').click(); await waitEnabled();
    assert.equal((await request('network.send')).stateAtRequest, 'connected');
    assert.equal((await request('network.start')).payload.mode, 'tcp-client');
    assert.equal((await request('network.start')).payload.remotePort, 9010);

    const repeatBase = await count('network.send');
    await field('重发次数').fill('3'); await field('重发间隔').fill('150');
    await page.evaluate(() => { window.__packetFixture.holdTx = true; });
    await button('重复发送').click();
    await page.waitForFunction((expected) => window.__packetFixture.requests.filter((item) => item.type === 'network.send').length === expected, repeatBase + 1);
    for (const name of ['模板名称', '目标地址', '目标端口', '报文内容', '重发间隔', '重发次数']) assert.ok(await field(name).isDisabled(), `${name} is frozen during a repeat run`);
    assert.ok(await button('新建').isDisabled());
    await openTemplates();
    for (const name of ['载入', '导入', '删除模板 Imported fixture']) assert.ok(await templateButton(name).isDisabled(), `${name} cannot alter a frozen repeat draft`);
    assert.ok(await templateButton('导出').isEnabled(), 'read-only template export remains available during a run');
    await closeTemplates();
    await page.waitForTimeout(350); assert.equal(await count('network.send'), repeatBase + 1, 'another packet is not queued before TX acknowledgment');
    await page.evaluate(() => { window.__packetFixture.holdTx = false; }); await waitEnabled();
    await page.waitForTimeout(350); assert.equal(await count('network.send'), repeatBase + 3, 'repeat sends exactly the requested count');
    const run = await page.evaluate((base) => window.__packetFixture.requests.filter((item) => item.type === 'network.send').slice(base), repeatBase);
    assert.ok(run.every((item) => item.payload.dataHex === '00ff41' && item.pendingAtRequest === 0), 'run bytes are fixed and queue remains serial');

    await field('重发次数').fill('20'); await field('重发间隔').fill('300');
    const stopBase = await count('network.send'); await button('重复发送').click();
    await page.waitForFunction((base) => window.__packetFixture.requests.filter((item) => item.type === 'network.send').length > base, stopBase);
    await button('停止 / 断开').click(); await waitEnabled();
    const stoppedAt = await count('network.send'); await page.waitForTimeout(550);
    assert.equal(await count('network.send'), stoppedAt, 'stop invalidates all future repeat sends');

    // Multicast and LAN operations are simulated; no Winsock socket is opened.
    await page.getByRole('tab', { name: 'UDP', exact: true }).click(); await field('目标地址').fill('224.20.20.20');
    await field('目标端口').fill('24576');
    const lanBase = await count('network.start'), lanSendBase = await count('network.send'), stopBeforeConsent = await count('network.stop');
    await button('发送一次').click(); await consentDialog().waitFor();
    assert.ok((await consentDialog().innerText()).includes('224.20.20.20'), 'consent identifies the frozen multicast destination');
    assert.ok((await consentDialog().innerText()).includes('24576'), 'consent identifies destination port');
    assert.equal(await count('network.start'), lanBase, 'showing consent has not started the transport');
    await consentDialog().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await count('network.start'), lanBase); assert.equal(await count('network.send'), lanSendBase);
    assert.equal(await count('network.stop'), stopBeforeConsent, 'cancel is entirely free of network mutation');
    assert.equal(await field('发送网卡').inputValue(), '127.0.0.1', 'cancel does not rewrite a legacy loopback template');
    const preservedLegacyLibrary = await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1'));
    await button('发送一次').click(); await confirmExternal(); await waitEnabled();
    assert.equal(await field('发送网卡').inputValue(), '0.0.0.0', 'confirmed legacy loopback draft migrates to automatic adapter');
    assert.equal((await request('network.start')).payload.multicastInterface, '0.0.0.0');
    assert.equal((await request('network.start')).payload.remotePort, 24576, 'migration never rewrites the destination port');
    assert.equal((await request('network.send')).payload.dataHex, '00ff41', 'migration never rewrites packet bytes');
    assert.equal(await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1')), preservedLegacyLibrary,
      'using a migrated draft does not silently rewrite the saved packet library');
    await stop();

    await field('发送网卡').selectOption('192.0.2.6'); await field('组播 TTL').fill('7');
    await field('发包本地端口').fill('54757');
    await button('发送一次').click(); await confirmExternal(); await waitEnabled();
    const lanRequest = await request('network.start');
    assert.equal(lanRequest.payload.remoteHost, '224.20.20.20'); assert.equal(lanRequest.payload.remotePort, 24576);
    assert.equal(lanRequest.payload.allowLan, true); assert.equal(lanRequest.payload.multicastInterface, '192.0.2.6');
    assert.equal(lanRequest.payload.localPort, 54757, 'local receive port is distinct from destination port');
    assert.equal(lanRequest.payload.multicastTtl, 7);
    assert.ok(!lanRequest.payload.multicastGroup, 'sending to a multicast address never implies joining its group');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), false);
    await stop();

    // Joining a group after sending retains the OS-assigned source/receive port.
    // This is the Packet Sender workflow where local "0" first becomes e.g. 54757.
    await field('发包本地端口').fill('0');
    await button('发送一次').click(); await confirmExternal(); await waitEnabled();
    const assignedPort = await page.evaluate(() => window.__packetFixture.snapshot.localPort);
    assert.ok(assignedPort > 0);
    assert.equal((await request('network.start')).payload.localPort, 0, 'initial ephemeral bind requests a system-assigned port');
    const sendsBeforeEphemeralJoin = await count('network.send');
    await button('加入组播').click(); await confirmExternal('加入'); await waitEnabled();
    const ephemeralJoin = await request('network.start');
    assert.equal(ephemeralJoin.payload.localPort, assignedPort, 'join keeps the established source port instead of allocating a new one');
    assert.equal(ephemeralJoin.payload.multicastGroup, '224.20.20.20');
    assert.equal(await count('network.send'), sendsBeforeEphemeralJoin, 'joining with nonempty payload still does not send it');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.localPort), assignedPort);
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), true);
    const startsBeforeEphemeralResend = await count('network.start');
    await button('发送一次').click(); await waitEnabled();
    assert.equal(await count('network.start'), startsBeforeEphemeralResend, 'resending through joined ephemeral socket does not restart it');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.localPort), assignedPort);
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), true);
    // Making an ephemeral port explicit and rejoining the same native socket must
    // update the requested-port identity used by future send/reuse decisions.
    await field('发包本地端口').fill(String(assignedPort));
    await button('加入组播').click(); await confirmExternal('加入'); await waitEnabled();
    const startsAfterExplicitJoin = await count('network.start');
    await button('发送一次').click(); await waitEnabled();
    assert.equal(await count('network.start'), startsAfterExplicitJoin, 'making the assigned port explicit does not cause the next send to restart or leave the group');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), true, 'explicit assigned-port reuse preserves membership');
    await stop();
    await field('发包本地端口').fill('0');
    await button('发送一次').click(); await confirmExternal(); await waitEnabled();
    assert.equal((await request('network.start')).payload.localPort, 0, 'manual stop clears the previous ephemeral-port pin');
    assert.ok(!(await request('network.start')).payload.multicastGroup, 'manual stop clears prior group membership intent');
    await stop();

    // Joining is a separate, explicit receive-only operation and works with empty data.
    await field('报文内容').fill(''); await button('同目标端口').click();
    assert.equal(await field('发包本地端口').inputValue(), '24576');
    const sendsBeforeJoin = await count('network.send');
    await page.evaluate(() => { window.__packetFixture.holdReady = true; });
    await button('加入组播').click(); await confirmExternal('加入');
    await page.waitForFunction(() => !!window.__packetFixture.snapshot.multicastGroup && window.__packetFixture.snapshot.state === 'starting');
    assert.equal(await count('network.send'), sendsBeforeJoin, 'joining never sends the edited payload');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), false, 'start acceptance is not membership acknowledgment');
    assert.equal(await page.getByTestId('packet-multicast-state').count(), 0, 'UI does not claim membership while native startup is pending');
    await page.evaluate(() => { window.__packetFixture.holdReady = false; });
    await page.waitForFunction(() => window.__packetFixture.snapshot.multicastJoined === true);
    await button('退出组播').waitFor();
    assert.ok((await page.getByTestId('packet-multicast-state').innerText()).includes('已加入 224.20.20.20'));
    const joinedRequest = await request('network.start');
    assert.equal(joinedRequest.payload.multicastGroup, '224.20.20.20');
    assert.equal(joinedRequest.payload.multicastInterface, '192.0.2.6'); assert.equal(joinedRequest.payload.localHost, '0.0.0.0');
    assert.equal(joinedRequest.payload.localPort, 24576);
    assert.equal(await count('network.send'), sendsBeforeJoin, 'joined ready state remains receive-only');
    await page.screenshot({ path: path.join(directory, 'multicast-synthetic-joined.png'), fullPage: true });
    await page.evaluate(() => {
      const fixture = window.__packetFixture;
      fixture.snapshot.rxPackets = 1; fixture.snapshot.rxBytes = 3;
      fixture.queue.push({ id: ++fixture.sequence, kind: 'received', timestamp: Date.now(), peerLabel: '192.0.2.8:24576', dataHex: '00ff41', byteLength: 3 });
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="网络收发记录"]').textContent.includes('RX ←'));
    const startsWhileJoined = await count('network.start');
    await field('报文内容').fill('00 ff 41'); await button('发送一次').click(); await waitEnabled();
    assert.equal(await count('network.start'), startsWhileJoined, 'an explicit send reuses the joined socket without dropping membership');
    assert.equal(await count('network.send'), sendsBeforeJoin + 1);
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), true);

    // A real-looking active status, including wrapping multicast details, must not
    // steal the console's minimum readable height. All state is fixture-only.
    const layoutStartBase = await count('network.start'), layoutSendBase = await count('network.send');
    const libraryPanel = page.getByTestId('packet-library-panel');
    await openTemplates(); await templateButton('删除模板 Imported fixture').click();
    await dialog.getByRole('button', { name: '删除模板', exact: true }).click();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 0);
    await closeTemplates();
    for (const [width, height, size] of [[1280, 762, 'comfortable'], [1024, 640, 'large']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
      await verifyReadableLayout(width, height, `active-empty-library-${width}-${size}`);
      assert.ok(await libraryPanel.isHidden(), 'empty templates occupy no space above traffic');
      assert.ok((await page.getByTestId('packet-multicast-state').innerText()).includes('已加入 224.20.20.20'));
      for (const control of [field('行尾'), field('重发间隔'), field('重发次数'), button('发送一次'), button('停止 / 断开')]) {
        assert.ok(await control.evaluate((element) => !!element.closest('[data-testid="network-operations"]')),
          'all send options and actions scroll together with the left editor');
        await control.scrollIntoViewIfNeeded(); const rect = await box(control);
        assert.ok(rect.y >= 0 && rect.bottom <= height + 1, 'scrolling the editor makes every send option reachable');
      }
      if (width === 1024) {
        const detailLines = await page.getByTestId('packet-multicast-state').locator('..').evaluate((element) => {
          const children = [...element.children].map((child) => child.getBoundingClientRect());
          return Math.max(...children.map((rect) => rect.bottom)) - Math.min(...children.map((rect) => rect.top));
        });
        assert.ok(detailLines > 25, 'large-text active endpoint details really wrap in this regression scenario');
      }
      await page.screenshot({ path: path.join(directory, `active-empty-library-${width}-${size}.png`), fullPage: true });
    }
    await openTemplates();
    await field('模板导入文件').setInputFiles({ name: 'layout-packets.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: Array.from({ length: 100 }, (_, index) => saved(`Layout fixture ${index + 1}`, `layout-${index}`)) })) });
    await page.waitForFunction(() => document.querySelector('[data-testid="packet-library"]').querySelectorAll('article').length === 100);
    const fullLibrary = await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1'));
    for (const invalid of [
      { name: 'too-many.json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: [saved('Overflow', 'overflow')] })), expected: /100/ },
      { name: 'too-large.json', buffer: Buffer.alloc(1024 * 1024 + 1, 32), expected: /1 MiB/ },
    ]) {
      await field('模板导入文件').setInputFiles({ name: invalid.name, buffer: invalid.buffer, mimeType: 'application/json' });
      await templateDialog().getByRole('alert').filter({ hasText: invalid.expected }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1')), fullLibrary,
        '100-template / 1 MiB limits reject input without overwriting existing data');
    }
    const exported = page.waitForEvent('download'); await templateButton('导出').click();
    const download = await exported;
    const exportJSON = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exportJSON.schemaVersion, 1); assert.equal(exportJSON.packets.length, 100, 'export keeps compatible schema and all templates');
    assert.equal(exportJSON.packets[0].payload, '00 ff 41');
    await closeTemplates();
    for (const [width, height, size] of [[1280, 762, 'comfortable'], [1920, 1040, 'large'], [1024, 640, 'large'], [760, 560, 'comfortable']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
      await verifyReadableLayout(width, height, `active-populated-library-${width}-${size}`);
      const logBeforeOpen = await box(log()); await openTemplates();
      const modal = await box(libraryPanel), packetList = await box(page.getByTestId('packet-library'));
      assert.ok(Math.abs((modal.x + modal.right) / 2 - width / 2) <= 2 && Math.abs((modal.y + modal.bottom) / 2 - height / 2) <= 2,
        'template browser is centered in the whole client, not just the details column');
      assert.ok(modal.y >= 0 && modal.bottom <= height + 1 && modal.x >= 0 && modal.right <= width + 1,
        'the entire template dialog fits the viewport');
      assert.ok(modal.scrollWidth <= modal.clientWidth + 1, 'templates do not horizontally overflow their dialog');
      assert.ok(packetList.scrollHeight > packetList.clientHeight && packetList.clientHeight > 0, 'saved entries scroll within their library');
      assert.equal((await box(log())).height, logBeforeOpen.height, 'opening 100 templates does not take height from traffic');
      await field('搜索模板').fill('fixture 100');
      assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 1, 'template name search narrows a large library');
      await field('搜索模板').fill('9000');
      assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 100, 'port search remains available');
      await field('搜索模板').fill('');
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
        assert.ok(await templateDialog().evaluate((element) => element.contains(document.activeElement)), 'template dialog traps keyboard focus');
      }
      await page.screenshot({ path: path.join(directory, `template-modal-${width}-${size}.png`), fullPage: true });
      await page.keyboard.press('Escape'); await templateDialog().waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '报文模板');
      assert.ok(await libraryPanel.isHidden(), 'closing removes the template panel from layout');
      assert.equal((await box(log())).height, logBeforeOpen.height, 'closing templates keeps the traffic viewport unchanged');
    }
    assert.equal(await count('network.start'), layoutStartBase, 'layout and library controls never restart the active session');
    assert.equal(await count('network.send'), layoutSendBase, 'layout and library controls never send');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), true, 'library changes do not leave the multicast group');
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await button('退出组播').click();
    await page.waitForFunction(() => window.__packetFixture.snapshot.state === 'stopped');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), false, 'stop releases membership');
    assert.equal(await count('network.send'), sendsBeforeJoin + 1);

    // A native membership failure is surfaced, never mistaken for a joined session.
    await page.evaluate(() => { window.__packetFixture.failJoinOnReady = 'Synthetic membership denied'; });
    await button('加入组播').click(); await confirmExternal('加入');
    await page.getByRole('alert').filter({ hasText: 'Synthetic membership denied' }).waitFor();
    await page.waitForFunction(() => window.__packetFixture.snapshot.state === 'stopped');
    assert.equal(await page.evaluate(() => window.__packetFixture.snapshot.multicastJoined), false);
    assert.equal(await count('network.send'), sendsBeforeJoin + 1);
    assert.equal(await page.getByTestId('packet-multicast-state').count(), 0, 'failed membership is never shown as joined');
    await page.getByRole('main').last().evaluate((element) => { element.scrollTop = 0; });
    const errorBounds = await box(page.getByRole('alert'));
    assert.ok(errorBounds.bottom <= page.viewportSize().height, 'native error is visible without scrolling the editor');
    await verifyReadableLayout(1280, 762, 'native membership error');
    await page.screenshot({ path: path.join(directory, 'multicast-synthetic-error.png'), fullPage: true });
    // A saved adapter that disappeared is never silently replaced by another route.
    await page.evaluate(() => { window.__packetFixture.interfaces = window.__packetFixture.interfaces.filter((adapter) => adapter.address !== '192.0.2.6'); });
    await button('刷新网卡').click();
    await page.waitForFunction(() => {
      const option = document.querySelector('[aria-label="发送网卡"] option[value="192.0.2.6"]'); return option && option.textContent.includes('不可用');
    });
    const startsBeforeMissingAdapter = await count('network.start');
    await button('发送一次').click();
    await page.getByRole('alert').filter({ hasText: '网卡当前不可用' }).waitFor();
    assert.equal(await count('network.start'), startsBeforeMissingAdapter, 'missing adapters are blocked, not silently rerouted');
    assert.equal(await consentDialog().count(), 0);
    await button('新建').click(); await field('发送网卡').selectOption('127.0.0.1');

    // Failures cancel the rest of a repeat run without replaying possibly sent data.
    await page.evaluate(() => { window.__packetFixture.failNextSend = 'Synthetic send failure'; });
    await field('重发次数').fill('4');
    const failureBase = await count('network.send'); await button('重复发送').click(); await waitEnabled();
    await page.waitForTimeout(300); assert.equal(await count('network.send'), failureBase + 1);
    assert.ok((await page.getByRole('alert').innerText()).includes('Synthetic send failure'));

    // Prioritize legible logs; short/large-text windows may scroll the whole page.
    await button('新建').click(); await field('发送网卡').selectOption('127.0.0.1');
    for (const [width, height] of [[1280, 762], [1024, 640], [1920, 1040], [760, 560]]) {
      await page.setViewportSize({ width, height });
      for (const size of ['comfortable', 'large']) {
        await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
        await verifyReadableLayout(width, height, `${width}x${height}-${size}`);
        await page.screenshot({ path: path.join(directory, `${width}x${height}-${size}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await button('发送一次').click(); await waitEnabled();
    const beforeLog = await box(log());
    await page.evaluate(() => {
      const fixture = window.__packetFixture;
      fixture.queue.push(...Array.from({ length: 6000 }, (_, index) => ({ id: ++fixture.sequence, kind: 'received', timestamp: Date.now() + index,
        peerLabel: 'synthetic only', dataHex: '00'.repeat(200), byteLength: 200 })));
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="网络收发记录"]').querySelectorAll('[data-kind]').length === 5000);
    const afterLog = await box(log());
    assert.equal(afterLog.height, beforeLog.height, 'incoming log rows never stretch the console');
    assert.ok(afterLog.scrollHeight > afterLog.clientHeight, 'traffic scrolls inside its bounded console');
    await page.screenshot({ path: path.join(directory, 'bounded-receive-log.png'), fullPage: true });

    await field('重发次数').fill('25'); await field('重发间隔').fill('100');
    await page.evaluate(() => { window.__packetFixture.holdTx = true; });
    const sendsBeforeUnmount = await count('network.send');
    await button('重复发送').click();
    await page.waitForFunction((base) => window.__packetFixture.requests.filter((item) => item.type === 'network.send').length > base, sendsBeforeUnmount);
    const beforeUnmount = await count('network.stop');
    await workspace().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await page.waitForFunction((before) => window.__packetFixture.requests.filter((item) => item.type === 'network.stop').length > before, beforeUnmount);
    await page.evaluate(() => { window.__packetFixture.holdTx = false; });
    await page.waitForTimeout(400);
    assert.equal(await count('network.send'), sendsBeforeUnmount + 1, 'leaving during pending TX cancels remaining repeat sends');
    assert.deepEqual(errors, [], 'no uncaught application exceptions');
    console.log('PASS: read-only adapters; no automatic effects; binary-safe UTF-8/HEX/escaped data; UDP/TCP wait for ready and actual TX; frozen repeat/stop; legacy template import/load/update/delete/export; centered 100-template browser/search/internal scrolling/focus; 100-template and 1 MiB import bounds; external consent/cancel; multicast interface/TTL; receive-only join/RX/leave/error; separate ports and ephemeral-to-explicit joined-port reuse; fully scrolling send options; 5000-row bounded logs with 320px usable height; natural vertical overflow, no horizontal clipping; default/1024/maximized split and narrow stack. All traffic is synthetic.');
  } catch (error) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
