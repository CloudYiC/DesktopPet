/** Synthetic Packet Sender UI regression. All network.* messages are handled in
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
      remoteHost: '127.0.0.1', remotePort: 9000, peers: [], rxPackets: 0, rxBytes: 0, txPackets: 0, txBytes: 0 };
    const state = window.__packetFixture = { requests: [], clipboard: [], snapshot: { ...stopped }, queue: [], pending: [],
      failNextStart: '', failNextSend: '', readyDelayPolls: 3, txDelayPolls: 3, readyRemaining: 0, holdTx: false, sequence: 0 };
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
          if (request.type === 'network.start') {
            message = state.failNextStart; state.failNextStart = '';
            if (!message) {
              state.snapshot = { ...stopped, ...payload, localPort: payload.localPort || 52123, state: 'starting' };
              state.readyRemaining = state.readyDelayPolls; state.pending = []; state.queue = []; state.sequence = 0;
            }
            result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.stop') {
            state.snapshot = { ...state.snapshot, state: 'stopped', lastError: '' }; state.pending = [];
            result = { snapshot: { ...state.snapshot } };
          } else if (request.type === 'network.send') {
            message = state.failNextSend; state.failNextSend = '';
            if (!message && !['ready', 'connected'].includes(state.snapshot.state)) message = 'Synthetic: send before transport ready';
            if (!message) state.pending.push({ hex: payload.dataHex, polls: state.txDelayPolls });
            result = { snapshot: { ...state.snapshot } };
          } else {
            if (state.snapshot.state === 'starting' || state.snapshot.state === 'connecting') {
              if (--state.readyRemaining <= 0) state.snapshot.state = state.snapshot.mode === 'udp' ? 'ready' : 'connected';
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
  const workspace = () => page.getByTestId('packet-sender-workspace');
  const field = (name) => page.getByLabel(name, { exact: true });
  const button = (name) => workspace().getByRole('button', { name, exact: true });
  const log = () => page.getByRole('log', { name: '发包收发记录', exact: true });
  const count = (type) => page.evaluate((type) => window.__packetFixture.requests.filter((request) => request.type === type).length, type);
  const request = (type) => page.evaluate((type) => window.__packetFixture.requests.filter((entry) => entry.type === type).at(-1), type);
  const waitEnabled = () => button('发送一次').waitFor({ state: 'visible' }).then(() => page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[data-testid="packet-sender-workspace"] button')].find((element) => element.textContent === '发送一次');
    return button && !button.disabled;
  }));
  const stop = async () => { if (await button('停止 / 断开').isEnabled()) { await button('停止 / 断开').click(); await waitEnabled(); } };
  async function openTool() {
    await page.getByRole('button', { name: /^工具首页/ }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '发包工具', exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click(); await workspace().waitFor();
  }
  async function box(locator) {
    return locator.evaluate((element) => { const rect = element.getBoundingClientRect(); return {
      x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    }; });
  }
  const saved = (name, id) => ({ id, updatedAt: '2026-09-14T00:00:00.000Z', name, protocol: 'udp', host: '127.0.0.1', port: 9000,
    localAddress: '127.0.0.1', localPort: 0, dataMode: 'hex', payload: '00 ff 41', intervalMs: 150, repeatCount: 3 });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard'); await openTool();
    await page.waitForTimeout(400);
    assert.equal(await count('network.start'), 0, 'opening the tool never establishes a session');
    assert.equal(await count('network.send'), 0, 'opening the tool never sends');

    // Editing, local templates and file loading have no native network effects.
    await field('报文内容').fill('');
    if (await button('发送一次').isEnabled()) await button('发送一次').click();
    assert.equal(await count('network.start'), 0, 'empty content is rejected before native startup');
    await workspace().locator('[class*="payloadToolbar"]').getByRole('button', { name: 'HEX', exact: true }).click();
    await field('报文内容').fill('00 ff 41'); await field('报文名称').fill('Fixture alpha');
    await button('保存报文').click();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 1);
    await button('新建').click(); await page.getByTestId('packet-library').getByRole('button', { name: '载入', exact: true }).click();
    assert.equal(await field('报文内容').inputValue(), '00 ff 41', 'saved template loads without loss');
    await button('删除报文 Fixture alpha').click();
    const dialog = page.getByRole('dialog', { name: '删除保存的报文？' }); await dialog.waitFor();
    const modal = await box(dialog), viewport = page.viewportSize();
    assert.ok(Math.abs((modal.x + modal.right) / 2 - viewport.width / 2) < 2, 'delete confirmation is centered in the entire client');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 1, 'cancel preserves the template');
    await button('删除报文 Fixture alpha').click(); await dialog.getByRole('button', { name: '删除报文', exact: true }).click();
    assert.equal(await page.getByTestId('packet-library').getByRole('article').count(), 0);
    await workspace().locator('input[type=file]').nth(0).setInputFiles({ name: 'packets.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: [saved('Imported fixture', 'fixture-import')] })) });
    await page.getByTestId('packet-library').getByRole('article').first().waitFor();
    await page.getByTestId('packet-library').getByRole('button', { name: '载入', exact: true }).click();
    assert.equal(await field('报文名称').inputValue(), 'Imported fixture');
    const libraryBeforeInvalidImport = await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1'));
    await workspace().locator('input[type=file]').nth(0).setInputFiles({ name: 'invalid.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, packets: [{ ...saved('Invalid', 'invalid-import'), autoSend: true }] })) });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('cloudyi.packet-sender.library.v1')), libraryBeforeInvalidImport,
      'unknown imported fields are rejected without overwriting saved templates');
    await workspace().locator('input[type=file]').nth(1).setInputFiles({ name: 'fixture.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 65]) });
    await page.waitForTimeout(50); assert.equal(await field('报文内容').inputValue(), '00 ff 41');
    assert.equal(await count('network.start'), 0, 'save, load, delete, import and binary file load do not connect');
    assert.equal(await count('network.send'), 0, 'all template operations are side-effect free');

    // UDP/TCP wait for asynchronous readiness and actual TX, not enqueue replies.
    await button('发送一次').click(); await waitEnabled();
    assert.equal(await count('network.send'), 1);
    assert.equal((await request('network.send')).stateAtRequest, 'ready');
    assert.equal((await request('network.send')).payload.dataHex, '00ff41');
    assert.ok((await log().innerText()).includes('TX →'), 'native completion appears in the receive log');
    await button('TCP').click(); await field('目标端口').fill('9010');
    await button('发送一次').click(); await waitEnabled();
    assert.equal((await request('network.send')).stateAtRequest, 'connected');
    assert.equal((await request('network.start')).payload.mode, 'tcp-client');
    assert.equal((await request('network.start')).payload.remotePort, 9010);

    const repeatBase = await count('network.send');
    await field('重发次数').fill('3'); await field('重发间隔').fill('150');
    await page.evaluate(() => { window.__packetFixture.holdTx = true; });
    await button('重复发送').click();
    await page.waitForFunction((expected) => window.__packetFixture.requests.filter((item) => item.type === 'network.send').length === expected, repeatBase + 1);
    for (const name of ['报文名称', '目标地址', '目标端口', '报文内容', '重发间隔', '重发次数']) assert.ok(await field(name).isDisabled(), `${name} is frozen during a repeat run`);
    assert.ok(await button('新建').isDisabled()); assert.ok(await button('载入').isDisabled());
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

    // Multicast and LAN addresses are inspected only by the fixture, never Winsock.
    await button('UDP').click(); await field('目标地址').fill('224.20.20.20');
    const lanBase = await count('network.start'); await button('发送一次').click();
    assert.equal(await count('network.start'), lanBase, 'loopback binding does not silently send to multicast');
    await field('本地 IPv4').fill('0.0.0.0');
    const consent = page.getByRole('checkbox', { name: '允许此本地地址收发局域网数据', exact: true });
    assert.equal(await consent.isChecked(), false);
    if (await button('发送一次').isEnabled()) await button('发送一次').click();
    assert.equal(await count('network.start'), lanBase, 'wildcard binding requires explicit consent');
    await consent.check(); await button('发送一次').click(); await waitEnabled();
    const lanRequest = await request('network.start');
    assert.equal(lanRequest.payload.remoteHost, '224.20.20.20'); assert.equal(lanRequest.payload.allowLan, true); assert.equal(lanRequest.payload.localHost, '0.0.0.0');
    await stop(); await button('新建').click();

    // Failures cancel the rest of a repeat run without replaying possibly sent data.
    await page.evaluate(() => { window.__packetFixture.failNextSend = 'Synthetic send failure'; });
    await field('重发次数').fill('4');
    const failureBase = await count('network.send'); await button('重复发送').click(); await waitEnabled();
    await page.waitForTimeout(300); assert.equal(await count('network.send'), failureBase + 1);
    assert.ok((await page.getByRole('alert').innerText()).includes('Synthetic send failure'));

    // Stable split workspace at the normal and maximized sizes, natural narrow stack.
    await button('新建').click();
    for (const [width, height] of [[1280, 762], [1920, 1040], [760, 560]]) {
      await page.setViewportSize({ width, height });
      for (const size of ['comfortable', 'large']) {
        await page.evaluate((size) => { document.documentElement.dataset.workspaceTextSize = size; }, size);
        const outer = await box(page.getByRole('main').last()), left = await box(page.getByTestId('packet-sender-editor')), right = await box(page.getByTestId('packet-sender-results'));
        assert.ok(outer.scrollWidth <= outer.clientWidth + 1, 'no horizontal page scrollbar');
        if (width > 900) {
          assert.ok(right.x >= left.right + 8 && Math.abs(right.y - left.y) <= 2, 'default/maximized use aligned left editing and right results');
          assert.ok(outer.scrollHeight <= outer.clientHeight + 1, 'large layouts do not require whole-page scrolling');
          assert.ok(right.bottom <= height + 1, 'results remain within the client viewport');
          assert.ok((await box(log())).height >= 210, 'receive log keeps useful height');
        } else assert.ok(right.y >= left.bottom, 'only narrow windows use a natural stack');
        assert.ok((await box(field('报文内容'))).height >= 110, 'payload editor is not squeezed');
        await page.screenshot({ path: path.join(directory, `${width}x${height}-${size}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 762 });
    await page.evaluate(() => { document.documentElement.dataset.workspaceTextSize = 'comfortable'; });
    await button('发送一次').click(); await waitEnabled();
    const beforeLog = await box(log());
    await page.evaluate(() => {
      const fixture = window.__packetFixture;
      fixture.queue.push(...Array.from({ length: 1200 }, (_, index) => ({ id: ++fixture.sequence, kind: 'received', timestamp: Date.now() + index,
        peerLabel: 'synthetic only', dataHex: '00'.repeat(200), byteLength: 200 })));
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="发包收发记录"]').querySelectorAll('[data-kind]').length === 1000);
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
    console.log('PASS: no automatic network effects; binary-safe UDP/TCP wait for ready and actual TX; exact frozen repeat/stop; template import/load/delete; explicit LAN consent; bounded logs; default/maximized split and narrow stack. All traffic is synthetic.');
  } catch (error) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
