/** Isolated utility-workspace UI regression. A synthetic host uses known Node fixtures;
 * no application profile, real clipboard, or native file/system operation is touched. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

function syntheticTool(request) {
  const input = String(request.input ?? '');
  const bytes = Buffer.from(input, 'utf8');
  const decodeUtf8 = (value) => new TextDecoder('utf-8', { fatal: true }).decode(value);
  if (request.toolId === 'base64') {
    if (request.operation === 'encode') {
      let encoded = bytes.toString(request.urlSafe ? 'base64url' : 'base64');
      if (request.urlSafe && request.padded !== false) encoded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      return request.padded === false ? encoded.replace(/=+$/, '') : encoded;
    }
    const compact = input.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) throw new Error('Base64 格式错误。');
    return decodeUtf8(Buffer.from(compact, 'base64'));
  }
  if (request.toolId === 'hex') {
    if (request.operation === 'encode') return bytes.toString('hex');
    const compact = input.replace(/^0x/i, '').replace(/[\s_]/g, '');
    if (!/^(?:[0-9a-f]{2})*$/i.test(compact)) throw new Error('Hex 内容格式不正确。');
    return decodeUtf8(Buffer.from(compact, 'hex'));
  }
  if (request.toolId === 'url-encode') {
    return request.operation === 'decode' ? decodeURIComponent(input.replace(/\+/g, ' '))
      : request.operation === 'encode-url' ? encodeURI(input) : encodeURIComponent(input);
  }
  if (request.toolId === 'hash') return crypto.createHash(request.operation).update(bytes).digest('hex');
  if (request.toolId === 'timestamp') {
    if (!/^-?\d+$/.test(input.trim())) throw new Error('时间戳必须是整数。');
    const milliseconds = Number(input) * (request.operation === 'seconds' ? 1000 : 1);
    if (!Number.isFinite(milliseconds) || Number.isNaN(new Date(milliseconds).getTime())) throw new Error('时间戳超出支持范围。');
    return new Date(milliseconds).toISOString();
  }
  if (request.toolId === 'uuid') {
    const count = Number(input);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('UUID 数量需要是 1 到 50 之间的整数。');
    return Array.from({ length: count }, () => {
      if (request.operation !== 'v7') return crypto.randomUUID();
      const data = crypto.randomBytes(16);
      data.writeUIntBE(Date.now(), 0, 6); data[6] = (data[6] & 15) | 0x70; data[8] = (data[8] & 63) | 0x80;
      const hex = data.toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }).join('\n');
  }
  if (request.toolId === 'password') {
    const length = Number(input);
    if (!Number.isInteger(length) || length < 4 || length > 128) throw new Error('密码长度需要是 4 到 128 之间的整数。');
    const seed = request.operation === 'pin' ? '0123456789' : request.operation === 'strong' ? 'aA1!zZ9@' : 'aA1zZ9';
    return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  }
  throw new Error(`Unsupported synthetic operation: ${request.toolId}/${request.operation}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.exposeBinding('__syntheticUtilityTool', (_source, request) => syntheticTool(request));
  await context.addInitScript(() => {
    const listeners = new Set();
    const state = window.__utilityFixture = { requests: [], clipboard: [], clipboardFails: false, readDelay: 0, pendingReads: 0, delay: 60, failNext: '' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value) => { if (state.clipboardFails) throw new Error('Synthetic clipboard denied'); state.clipboard.push(String(value)); },
      readText: async () => {
        const value = state.clipboard.at(-1) || '';
        state.pendingReads += 1;
        try { if (state.readDelay) await new Promise((resolve) => setTimeout(resolve, state.readDelay)); return value; }
        finally { state.pendingReads -= 1; }
      },
    } });
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        state.requests.push(request);
        if (request.type !== 'tool.execute') return;
        const failure = state.failNext; state.failNext = '';
        setTimeout(async () => {
          const payload = request.payload;
          try {
            if (failure) throw new Error(failure);
            const output = await window.__syntheticUtilityTool(payload);
            listeners.forEach((listener) => listener({ data: { type: 'tool.result', payload: { requestId: payload.requestId, output } } }));
          } catch (error) {
            listeners.forEach((listener) => listener({ data: { type: 'tool.error', payload: { requestId: payload.requestId, message: String(error.message || error) } } }));
          }
        }, state.delay);
      },
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outputDirectory = path.resolve(__dirname, '../artifacts/utility-workspaces');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const checks = [];
  const button = (name) => ['执行转换', '计算哈希', '处理 JSON', '转换时间', '生成 UUID', '生成密码'].includes(name)
    ? page.getByRole('button', { name: new RegExp(`^${name}(?:\\s*Ctrl Enter)?$`) })
    : name === '反向转换' ? page.getByRole('button', { name: /^反向转换/ })
      : page.getByRole('button', { name, exact: true });
  const mode = (name) => page.getByRole('tab', { name, exact: true });
  const header = () => page.locator('header[aria-label="工具详情导航"]');
  const input = () => page.getByTestId('codec-input');
  const output = () => page.getByTestId('codec-output');
  const fixture = (values) => page.evaluate((values) => Object.assign(window.__utilityFixture, values), values);
  const countRequests = () => page.evaluate(() => window.__utilityFixture.requests.filter((request) => request.type === 'tool.execute').length);
  async function openTool(name) {
    if (await header().count()) await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
    await page.getByRole('button', { name: /^工具首页/ }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await header().getByRole('heading', { name, exact: true }).waitFor();
  }
  async function textValue(locator) {
    return locator.evaluate((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent || '');
  }
  async function expectedOutput(expected) {
    await page.waitForFunction(({ expected }) => {
      const element = document.querySelector('[data-testid="codec-output"]');
      return element && (element instanceof HTMLTextAreaElement ? element.value : element.textContent) === expected;
    }, { expected });
  }
  async function verifyLayout(name, workspaceId) {
    const dimensions = await page.getByTestId(workspaceId).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const main = element.closest('main');
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
        pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
        mainClientWidth: main?.clientWidth, mainScrollWidth: main?.scrollWidth,
        mainClientHeight: main?.clientHeight, mainScrollHeight: main?.scrollHeight };
    });
    const { width, height } = page.viewportSize();
    assert.ok(dimensions.right <= width + 1, `${name}: workspace fits viewport width ${width}`);
    assert.ok(dimensions.bottom <= height + 1, `${name}: workspace fits viewport height ${height}: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.mainScrollWidth <= dimensions.mainClientWidth + 1, `${name}: no main horizontal overflow at ${width}×${height}`);
    assert.ok(dimensions.mainScrollHeight <= dimensions.mainClientHeight + 1, `${name}: no outer vertical growth at ${width}×${height}`);
    const box = await header().boundingBox();
    assert.ok(box.y <= 13, `${name}: compact detail header`);
  }
  async function screenshot(name) {
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: path.join(outputDirectory, `${name}-${width}x${height}.png`), fullPage: true });
  }
  async function runCodec(name = '执行转换') {
    await button(name).click();
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('button')];
      const copy = buttons.find((element) => element.textContent.trim() === '复制结果');
      return copy && !copy.disabled;
    });
  }
  async function visibleMessage(pattern, role = 'alert') {
    const message = page.getByRole(role).filter({ hasText: pattern });
    await message.first().waitFor();
    assert.ok(await message.first().isVisible(), `visible ${role}: ${pattern}`);
  }
  async function verifyCodecTools() {
    const unicode = '云依 A😀 +/?=\nsecond line';
    const codecs = [
      { name: 'Base64', encode: '编码', encoded: Buffer.from(unicode).toString('base64'), invalid: '!!!not-base64!!!' },
      { name: 'Hex 编解码', encode: '编码', encoded: Buffer.from(unicode).toString('hex').toUpperCase().match(/../g).join(' '), invalid: '0G1' },
      { name: 'URL 编解码', encode: '组件编码', encoded: encodeURIComponent(unicode), invalid: '%ZZ' },
    ];
    for (const tool of codecs) {
      await openTool(tool.name);
      await mode(tool.encode).click();
      await input().fill(unicode);
      const bytes = Buffer.byteLength(unicode, 'utf8');
      assert.match(await page.getByTestId('codec-input-stats').innerText(), new RegExp(`\\b${bytes}\\b`), `${tool.name} counts UTF-8 bytes`);
      await runCodec(); await expectedOutput(tool.encoded);
      await button('反向转换').click(); await expectedOutput(unicode);
      await mode(tool.encode).click();
      assert.ok(await button('复制结果').isDisabled(), `${tool.name} switching mode invalidates prior result`);
      await mode('解码').click(); await input().fill(tool.invalid);
      await button('执行转换').click(); await visibleMessage(/格式|URI|encoding|Base64|Hex|malformed/i);
      assert.ok(await button('复制结果').isDisabled(), `${tool.name} error cannot copy prior result`);
      await mode(tool.encode).click(); await input().fill(''); await runCodec();
      assert.equal(await textValue(output()), '', `${tool.name} empty input returns empty string`);
      assert.equal(await button('复制结果').isDisabled(), false, `${tool.name} successful empty result remains copyable`);
      await verifyLayout(tool.name, 'codec-workspace');
      checks.push(`${tool.name} Unicode roundtrip / bytes / invalid input / empty result / stale copy`);
    }
    await openTool('Base64');
    await input().fill('云依😀');
    await page.getByRole('checkbox', { name: 'URL 安全', exact: true }).check();
    await page.getByRole('checkbox', { name: '保留补位', exact: true }).uncheck();
    await runCodec(); await expectedOutput(Buffer.from('云依😀').toString('base64url'));
    await fixture({ delay: 350 }); await input().fill('single operation');
    const before = await countRequests();
    await button('执行转换').evaluate((element) => { element.click(); element.click(); });
    await expectedOutput(Buffer.from('single operation').toString('base64url'));
    assert.equal(await countRequests(), before + 1, 'synchronous run lock rejects a double click');
    await fixture({ delay: 60, clipboardFails: true });
    await button('复制结果').click(); await visibleMessage(/复制失败|剪贴板/, 'status');
    await fixture({ clipboardFails: false }); await button('复制结果').click();
    assert.equal(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), Buffer.from('single operation').toString('base64url'));
    await fixture({ failNext: '模拟原生工具失败' }); await input().fill('native failure');
    await button('执行转换').click(); await visibleMessage(/模拟原生工具失败/);
    assert.ok(await button('复制结果').isDisabled());
    checks.push('Base64 options, synchronous duplicate guard, native failure, isolated clipboard failure/recovery');
    await fixture({ readDelay: 750, clipboard: ['迟到的剪贴板内容'] });
    await input().fill(''); await button('粘贴文本').click(); await button('清空输入').click();
    await page.waitForFunction(() => window.__utilityFixture.pendingReads === 0);
    assert.equal(await input().inputValue(), '', 'clearing an already-empty input cancels a pending clipboard read');
    await input().fill('A'); await button('粘贴文本').click();
    await input().fill('B'); await input().fill('A');
    await page.waitForFunction(() => window.__utilityFixture.pendingReads === 0);
    assert.equal(await input().inputValue(), 'A', 'A-to-B-to-A edits still invalidate an older clipboard read');
    await fixture({ readDelay: 0 });
    checks.push('Delayed clipboard read cancellation after clear-empty and A-B-A edits');

    await openTool('Hex 编解码'); await input().fill(unicode);
    await page.getByRole('checkbox', { name: '大写', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '分隔字节', exact: true }).uncheck();
    await runCodec(); await expectedOutput(Buffer.from(unicode).toString('hex'));
    checks.push('Hex lowercase and unseparated output options');

    await openTool('URL 编解码');
    await mode('完整 URL 编码').click();
    const url = 'https://x.test/a+b?q=c+d&name=云依 世界#片段';
    await input().fill(url); await runCodec(); await expectedOutput(encodeURI(url));
    await button('反向转换').click(); await expectedOutput(url);
    const plusAsSpace = page.getByRole('checkbox', { name: '加号转空格', exact: true });
    assert.equal(await plusAsSpace.isChecked(), false, 'reversing a full URL preserves literal plus characters');
    await input().fill('a+b'); await runCodec(); await expectedOutput('a+b');
    await plusAsSpace.check(); assert.ok(await button('复制结果').isDisabled(), 'plus-decoding option change invalidates output');
    await runCodec(); await expectedOutput('a b');
    await mode('组件编码').click(); assert.ok(await button('复制结果').isDisabled(), 'switching from URL decode invalidates output');
    await runCodec(); await expectedOutput('a%2Bb');
    await mode('解码').click(); assert.ok(await button('复制结果').isDisabled(), 'switching to URL decode invalidates output');
    checks.push('URL component/full-URL encoding, literal-plus reverse roundtrip and plus-as-space decoding option');

    await openTool('哈希计算');
    for (const [operation, label] of [['sha256', 'SHA-256'], ['md5', 'MD5']]) {
      await mode(label).click(); await input().fill(unicode); await runCodec('计算哈希');
      await expectedOutput(crypto.createHash(operation).update(unicode).digest('hex'));
      await input().fill(''); await runCodec('计算哈希');
      await expectedOutput(crypto.createHash(operation).update('').digest('hex'));
    }
    const digest = crypto.createHash('md5').update('').digest('hex');
    await page.getByRole('textbox', { name: '期望哈希值', exact: true }).fill(digest.toUpperCase());
    await visibleMessage(/摘要一致/, 'status');
    await page.getByRole('textbox', { name: '期望哈希值', exact: true }).fill('0000');
    await visibleMessage(/摘要不一致/, 'status');
    checks.push('SHA-256 and MD5 known Unicode / empty digests');

    await openTool('JSON 格式化');
    const json = { name: '云依😀', enabled: true, values: [1, null, 'a\nb'] };
    await input().fill(JSON.stringify(json)); await mode('格式化').click(); await runCodec('处理 JSON');
    await expectedOutput(JSON.stringify(json, null, 2));
    await page.getByRole('combobox', { name: 'JSON 缩进', exact: true }).selectOption('4');
    assert.ok(await button('复制结果').isDisabled()); await runCodec('处理 JSON');
    await expectedOutput(JSON.stringify(json, null, 4));
    await mode('压缩').click(); assert.ok(await button('复制结果').isDisabled());
    await runCodec('处理 JSON'); await expectedOutput(JSON.stringify(json));
    await input().fill('{invalid:'); await button('处理 JSON').click(); await visibleMessage(/JSON|Unexpected|Expected|属性|解析/);
    assert.ok(await button('复制结果').isDisabled());
    await input().fill(''); await button('处理 JSON').click(); await visibleMessage(/JSON|输入|Unexpected|解析/);
    const longJson = Array.from({ length: 350 }, (_, index) => ({ index, text: `云依的合成测试数据 ${index} ${'long text '.repeat(6)}` }));
    await input().fill(JSON.stringify(longJson, null, 2)); await mode('格式化').click(); await runCodec('处理 JSON');
    const original = await input().boundingBox();
    const outputOriginal = await output().boundingBox();
    await input().evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await output().evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await input().evaluate((element) => element.scrollTop > 0), 'long JSON input scrolls internally');
    assert.ok(await output().evaluate((element) => element.scrollTop > 0), 'long JSON output scrolls internally');
    assert.deepEqual(await input().boundingBox(), original, 'input scrolling does not shift the workspace');
    assert.deepEqual(await output().boundingBox(), outputOriginal, 'output scrolling does not shift the workspace');
    await verifyLayout('JSON 格式化', 'codec-workspace'); await screenshot('json-long');
    checks.push('JSON format/minify, invalid/empty errors, long input/output independent scroll');
  }
  async function verifyRegex() {
    await openTool('正则表达式');
    const pattern = page.getByRole('textbox', { name: '正则表达式', exact: true });
    const flags = page.getByRole('textbox', { name: '匹配标志', exact: true });
    const text = page.getByRole('textbox', { name: '待匹配文本', exact: true });
    const match = page.getByTestId('regex-match');
    await pattern.fill('(云依)|(\\d+)'); await flags.fill('g'); await text.fill('云依 yunyi 123 云依');
    await button('测试匹配').click(); await page.waitForFunction(() => document.querySelectorAll('[data-testid="regex-match"]').length === 3);
    await match.nth(1).getByRole('button', { name: '定位匹配 2', exact: true }).click();
    await page.locator('mark[data-match-index="1"]').waitFor();
    assert.ok(await page.locator('mark[data-match-index="1"]').isVisible());
    await button('复制匹配').click();
    assert.match(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), /123/);
    await pattern.fill('('); assert.ok(await button('复制匹配').isDisabled());
    await button('测试匹配').click(); await visibleMessage(/正则|表达式|Invalid|Unterminated/);
    await pattern.fill('云依'); await flags.fill('gg'); await button('测试匹配').click(); await visibleMessage(/重复|标志|flag/i);
    await button('编辑文本').click();
    await pattern.fill('(?=)'); await flags.fill('gu'); await text.fill('😀中'); await button('测试匹配').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="regex-match"]').length === 3);
    await flags.fill(''); await pattern.fill('云依'); await text.fill('云依 云依'); await button('测试匹配').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="regex-match"]').length === 1);
    await flags.fill('g'); await pattern.fill('x'); await text.fill(''); await button('测试匹配').click();
    await visibleMessage(/0|没有|未匹配/, 'status');
    await pattern.fill('row'); await text.fill('row 云依\n'.repeat(1200)); await button('测试匹配').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="regex-match"]').length > 0);
    assert.ok(await match.count() <= 1000, 'regex display is bounded to 1000 matches');
    await text.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await text.evaluate((element) => element.scrollTop > 0));
    await page.getByTestId('regex-results').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await page.getByTestId('regex-results').evaluate((element) => element.scrollTop > 0));
    await verifyLayout('正则表达式', 'regex-workspace'); await screenshot('regex-long');
    await pattern.fill('(a+)+$'); await text.fill('a'.repeat(50_000) + '!');
    await button('测试匹配').click(); await button('停止匹配').click();
    await visibleMessage(/已停止/, 'status');
    await button('测试匹配').click(); await visibleMessage(/超过 2.5 秒.*安全停止/);
    await pattern.fill('x'); await text.fill('x'); await button('测试匹配').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="regex-match"]').length === 1);
    checks.push('Regex capture groups, selected highlight, invalid pattern/flags, Unicode zero-width, non-global/empty, bounded scrolling');
    checks.push('Regex worker manual stop, 2.5-second pathological-pattern timeout and recovery');
  }
  async function verifySpecialized() {
    const result = () => page.getByTestId('specialized-result');
    await openTool('时间戳');
    const timestamp = page.getByRole('textbox', { name: 'Unix 时间戳', exact: true });
    await timestamp.fill('0'); await button('秒（s）').click(); await button('转换时间').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="specialized-result"]')?.textContent.includes('1970-01-01'));
    await button('复制 UTC').click(); assert.match(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), /^1970-01-01/);
    await timestamp.fill('1000'); assert.ok(!await button('复制 UTC').count() || await button('复制 UTC').isDisabled());
    await button('毫秒（ms）').click(); await button('转换时间').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="specialized-result"]')?.textContent.includes('00:00:01'));
    await timestamp.fill('not-a-timestamp'); await button('转换时间').click(); await visibleMessage(/时间戳|整数/);
    await timestamp.fill(''); await button('转换时间').click(); await visibleMessage(/时间戳|输入|整数/);
    await button('使用当前时间').click(); assert.match(await timestamp.inputValue(), /^\d+$/);
    await timestamp.fill('-1'); await button('毫秒（ms）').click(); await button('转换时间').click();
    await button('复制 Unix 秒').click(); assert.equal(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), '-0.001');
    checks.push('Timestamp seconds/milliseconds epoch conversion, copy, invalid/empty input and current time');

    await openTool('UUID 生成器');
    const count = page.getByRole('spinbutton', { name: '生成数量', exact: true });
    await count.fill('50'); await button('UUID v4').click(); await button('生成 UUID').click();
    await page.getByRole('button', { name: '复制第 50 个 UUID', exact: true }).waitFor();
    await button('复制全部').click();
    let uuids = (await page.evaluate(() => window.__utilityFixture.clipboard.at(-1))).trim().split('\n');
    assert.equal(uuids.length, 50); assert.equal(new Set(uuids).size, 50);
    assert.ok(uuids.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)));
    const uuidScroll = result().locator(':scope > div');
    const uuidFrame = await result().boundingBox();
    await uuidScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await uuidScroll.evaluate((element) => element.scrollTop > 0), 'UUID rows scroll inside their result container');
    assert.deepEqual(await result().boundingBox(), uuidFrame, '50 UUIDs never grow the result panel');
    await verifyLayout('UUID 生成器', 'specialized-workspace'); await screenshot('uuid-50-rows');
    await button('UUID v7').click(); assert.ok(await button('复制全部').isDisabled());
    await count.fill('3'); await button('生成 UUID').click(); await button('复制第 3 个 UUID').waitFor();
    await button('复制全部').click(); uuids = (await page.evaluate(() => window.__utilityFixture.clipboard.at(-1))).trim().split('\n');
    assert.equal(uuids.length, 3); assert.ok(uuids.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)));
    await count.fill('0'); await button('生成 UUID').click(); await visibleMessage(/数量|1.*50/);
    await count.fill('51'); await button('生成 UUID').click(); await visibleMessage(/数量|1.*50/);
    checks.push('UUID v4/v7 format, 50 unique rows, stale copy and bounds');

    await openTool('密码生成器');
    const length = page.getByRole('spinbutton', { name: '密码长度', exact: true });
    await length.fill('20'); await button('含符号').click(); await button('生成密码').click();
    await button('复制密码').waitFor(); await button('复制密码').click();
    const password = await page.evaluate(() => window.__utilityFixture.clipboard.at(-1));
    assert.equal(password.length, 20); assert.match(password, /[a-z]/); assert.match(password, /[A-Z]/); assert.match(password, /[0-9]/); assert.match(password, /[^A-Za-z0-9]/);
    await button('显示密码').click(); assert.ok((await result().innerText()).includes(password));
    await button('隐藏密码').click(); assert.equal((await result().innerText()).includes(password), false);
    await button('纯数字 PIN').click(); assert.ok(await button('复制密码').isDisabled());
    await length.fill('6'); await button('生成密码').click(); await button('复制密码').click();
    assert.match(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), /^\d{6}$/);
    await button('字母与数字').click(); await length.fill('12'); await button('生成密码').click(); await button('复制密码').click();
    assert.match(await page.evaluate(() => window.__utilityFixture.clipboard.at(-1)), /^[A-Za-z0-9]{12}$/);
    await length.fill('3'); await button('生成密码').click(); await visibleMessage(/长度|4.*128/);
    await length.fill('16'); await fixture({ delay: 350 });
    const before = await countRequests();
    await button('生成密码').evaluate((element) => { element.click(); element.click(); });
    await length.fill('17');
    await button('生成密码').waitFor();
    assert.equal(await countRequests(), before + 1, 'password duplicate execution is guarded');
    assert.ok(await button('复制密码').isDisabled(), 'pending password response cannot populate changed parameters');
    await fixture({ delay: 60 });
    checks.push('Password character sets, length, conceal/reveal, copy, PIN and validation');
  }
  async function verifyResponsive() {
    const tools = [['Base64', 'codec-workspace'], ['Hex 编解码', 'codec-workspace'], ['URL 编解码', 'codec-workspace'], ['JSON 格式化', 'codec-workspace'], ['哈希计算', 'codec-workspace'], ['正则表达式', 'regex-workspace'], ['时间戳', 'specialized-workspace'], ['UUID 生成器', 'specialized-workspace'], ['密码生成器', 'specialized-workspace']];
    for (const width of [1280, 1024, 760]) for (const height of [800, 600]) {
      await page.setViewportSize({ width, height });
      for (const [name, testId] of tools) {
        await openTool(name); await verifyLayout(name, testId);
        const actions = await page.getByTestId(testId).getByRole('button').evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { label: element.getAttribute('aria-label') || element.textContent.trim(), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        }));
        for (const action of actions.filter((item) => item.width > 0 && item.height > 0)) {
          assert.ok(action.x >= 0 && action.y >= 0 && action.right <= width + 1 && action.bottom <= height + 1,
            `${name} ${action.label} is fully inside ${width}×${height}: ${JSON.stringify(action)}`);
        }
        if (width === 1280 && height === 800 || width === 760 && height === 600) await screenshot(name);
      }
    }
    checks.push('9 tools × 6 viewport sizes: fixed workspace, compact headers, no outer overflow');
  }
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await verifyCodecTools();
    await verifyRegex();
    await verifySpecialized();
    await verifyResponsive();
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log(`PASS: ${checks.join('; ')}`);
    console.log(`Screenshots: ${outputDirectory}`);
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
