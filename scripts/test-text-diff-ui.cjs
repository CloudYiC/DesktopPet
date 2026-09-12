/** Text comparison regression in an isolated browser; clipboard writes remain in memory. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PACKET_TEST_BROWSER || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Never grant clipboard permission or touch the host clipboard during this regression.
  await context.addInitScript(() => {
    window.__textDiffClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => { window.__textDiffClipboardWrites.push(String(value)); },
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/text-diff');
  fs.mkdirSync(output, { recursive: true });

  const button = (name) => page.getByRole('button', { name, exact: true });
  const leftInput = page.getByRole('textbox', { name: '原始文本', exact: true });
  const rightInput = page.getByRole('textbox', { name: '修改后文本', exact: true });
  const region = page.getByRole('region', { name: '文本对照结果', exact: true });
  const scroll = page.getByTestId('diff-scroll');
  const rows = () => region.locator('[data-diff-row][data-kind]:visible');
  const stats = page.locator('output[aria-label="差异统计"]');
  const position = page.locator('output[aria-label="差异位置"]');
  const changesOnly = page.getByRole('checkbox', { name: '只看差异', exact: true });
  const ignoreWhitespace = page.getByRole('checkbox', { name: '忽略行首尾空白', exact: true });
  const dirtyNotice = page.getByText(/(?:文本|输入).*(?:已更改|已修改|已更新)|请.*重新比较|尚未比较/).first();

  async function setPair(left, right) {
    if (await button('展开输入').isVisible()) await button('展开输入').click();
    await leftInput.fill(left);
    await rightInput.fill(right);
  }

  async function compare(left, right) {
    await setPair(left, right);
    await button('开始比较').click();
    await region.waitFor({ state: 'visible' });
  }

  async function expectKinds(expected) {
    await page.waitForFunction((kinds) => {
      const actual = [...document.querySelectorAll('[data-diff-row][data-kind]')]
        .filter((row) => row.getClientRects().length > 0)
        .map((row) => row.getAttribute('data-kind'));
      return JSON.stringify(actual) === JSON.stringify(kinds);
    }, expected);
    assert.deepEqual(await rows().evaluateAll((elements) => elements.map((row) => row.dataset.kind)), expected);
  }

  async function expectPosition(current, total) {
    await page.waitForFunction(({ current, total }) => {
      const text = document.querySelector('output[aria-label="差异位置"]')?.textContent || '';
      const values = (text.match(/\d+/g) || []).map(Number);
      return values.length === 2 && values[0] === current && values[1] === total;
    }, { current, total });
    assert.deepEqual(((await position.innerText()).match(/\d+/g) || []).map(Number), [current, total]);
  }

  async function expectStat(label, count) {
    const value = (await stats.innerText()).replace(/\s+/g, ' ');
    const labelBeforeCount = new RegExp(`${label}[^\\d]{0,12}${count}(?!\\d)`);
    const countBeforeLabel = new RegExp(`(?:^|[^\\d])${count}\\s*(?:行|处)?\\s*${label}`);
    assert.ok(labelBeforeCount.test(value) || countBeforeLabel.test(value), `Expected ${label} ${count}; got: ${value}`);
  }

  async function outerScrollSnapshot() {
    return scroll.evaluate((element) => {
      const ancestors = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        ancestors.push({ tag: node.tagName, top: node.scrollTop, left: node.scrollLeft });
      }
      return { windowX: window.scrollX, windowY: window.scrollY, ancestors };
    });
  }

  async function expectRowInScroll(rowIndex) {
    await page.waitForFunction((index) => {
      const frame = document.querySelector('[data-testid="diff-scroll"]');
      const row = frame?.querySelector(`[data-diff-row="${index}"]`);
      if (!frame || !row) return false;
      const bounds = frame.getBoundingClientRect();
      const line = row.getBoundingClientRect();
      return line.top >= bounds.top - 2 && line.bottom <= bounds.bottom + 2;
    }, rowIndex);
  }

  async function expectContainedLayout(width) {
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    assert.equal(layout.viewport, width);
    assert.ok(layout.document <= width + 1, `Document must not overflow at ${width}px: ${JSON.stringify(layout)}`);
    assert.ok(layout.body <= width + 1, `Body must not overflow at ${width}px: ${JSON.stringify(layout)}`);
    const frame = await scroll.boundingBox();
    assert.ok(frame && frame.width > 0 && frame.x >= -1 && frame.x + frame.width <= width + 1,
      `Comparison stays inside the ${width}px viewport`);
    const metrics = await scroll.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    assert.ok(metrics.height > 100 && metrics.height < 800, 'Collapsed comparison has a bounded usable height');
    assert.ok(metrics.contentHeight > metrics.height + 20, 'Long results overflow inside the comparison');
    assert.match(metrics.overflowY, /^(auto|scroll)$/, 'Comparison owns its vertical scrolling');
  }

  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await page.getByRole('button', { name: /^⌂ 工具首页/ }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '文本比较', exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await leftInput.waitFor();
    await rightInput.waitFor();
    for (const name of ['开始比较', '交换文本', '清空文本', '载入示例', '收起输入']) {
      assert.equal(await button(name).count(), 1, `${name} is uniquely accessible`);
    }
    await changesOnly.uncheck();
    await ignoreWhitespace.uncheck();
    await region.waitFor();
    assert.ok((await leftInput.inputValue()).length > 0 && (await rightInput.inputValue()).length > 0,
      'Initial example is immediately available');
    await expectStat('新增', 1);
    await expectStat('删除', 1);
    await expectStat('修改', 2);
    await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });

    // Inserting one line must not make all following lines look modified.
    await compare('alpha\nbeta\ngamma\ndelta', 'alpha\nbeta\ninserted\ngamma\ndelta');
    await expectKinds(['same', 'same', 'add', 'same', 'same']);
    const inserted = rows().filter({ has: page.locator('[data-side="right"]', { hasText: 'inserted' }) });
    assert.equal(await inserted.count(), 1);
    assert.equal(await inserted.getAttribute('data-kind'), 'add');
    const following = region.locator('[data-diff-row="3"]');
    assert.match(await following.locator('[data-side="left"]').innerText(), /gamma/);
    assert.match(await following.locator('[data-side="right"]').innerText(), /gamma/);
    await expectStat('新增', 1);
    await page.screenshot({ path: path.join(output, 'diff-insert-1280.png'), fullPage: true });

    const original = 'service=api\nport=8080\nworkers=4\nenabled=true\nregion=cn';
    const modified = 'service=api\nport=9090\nworkers=4\nenabled=true\nregion=cn';
    await compare(original, modified);
    await expectKinds(['same', 'change', 'same', 'same', 'same']);
    const changed = region.locator('[data-kind="change"]');
    for (const side of ['left', 'right']) {
      const marks = changed.locator(`[data-side="${side}"] mark`);
      assert.ok(await marks.count() > 0, `${side} highlights changed characters`);
      const highlighted = (await marks.allTextContents()).join('');
      assert.ok(highlighted.length > 0 && highlighted.length < 'port=8080'.length,
        `${side} marks changed characters, not the entire line: ${highlighted}`);
    }
    await expectStat('修改', 1);
    await expectStat('新增', 0);
    await expectStat('删除', 0);
    await page.screenshot({ path: path.join(output, 'diff-inline-1280.png'), fullPage: true });

    assert.equal(await button('复制差异').isEnabled(), true);
    await button('复制差异').click();
    await page.waitForFunction(() => window.__textDiffClipboardWrites.length > 0);
    const copies = await page.evaluate(() => window.__textDiffClipboardWrites);
    assert.equal(copies.length, 1, 'Copy sends one value to the in-memory clipboard stub');
    assert.match(copies[0], /port=8080/);
    assert.match(copies[0], /port=9090/);

    await changesOnly.check();
    await expectKinds(['change']);
    assert.equal(await region.locator('[data-kind="same"]:visible').count(), 0);
    await region.getByText(/(?:省略|隐藏).*(?:相同|未更改|未修改)|(?:相同|未更改|未修改).*(?:省略|隐藏)/).first().waitFor();
    await page.screenshot({ path: path.join(output, 'diff-filtered-1280.png'), fullPage: true });
    await changesOnly.uncheck();
    await expectKinds(['same', 'change', 'same', 'same', 'same']);

    // Editing preserves the last comparison but makes its stale state explicit.
    await rightInput.fill(original);
    await dirtyNotice.waitFor({ state: 'visible' });
    assert.equal(await button('复制差异').isDisabled(), true, 'Stale results cannot be copied');
    assert.equal(await button('下一处差异').isDisabled(), true, 'Stale results cannot be navigated');
    await button('开始比较').click();
    await expectKinds(Array(5).fill('same'));
    await dirtyNotice.waitFor({ state: 'hidden' });
    await expectStat('修改', 0);
    const identicalState = await page.getByRole('main').last().innerText();
    assert.match(identicalState, /没有差异|无差异|完全一致|(?:文本|内容).{0,10}(?:相同|一致)/);

    await compare('alpha\n  beta\t\ngamma', ' alpha  \nbeta\n  gamma');
    assert.ok(await region.locator('[data-kind="change"], [data-kind="add"], [data-kind="remove"]').count() > 0,
      'Whitespace differences are visible by default');
    await ignoreWhitespace.check();
    await button('开始比较').click();
    await expectKinds(['same', 'same', 'same']);
    await expectStat('修改', 0);
    await ignoreWhitespace.uncheck();

    await setPair('swap-left\none', 'swap-right\ntwo');
    await button('交换文本').click();
    assert.equal(await leftInput.inputValue(), 'swap-right\ntwo');
    assert.equal(await rightInput.inputValue(), 'swap-left\none');
    await button('载入示例').click();
    const sampleLeft = await leftInput.inputValue();
    const sampleRight = await rightInput.inputValue();
    assert.ok(sampleLeft.length > 0 && sampleRight.length > 0 && sampleLeft !== sampleRight,
      'Example supplies two different nonempty texts');
    await button('开始比较').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-kind="change"], [data-kind="add"], [data-kind="remove"]').length > 0);

    // Two distant changes are two navigable groups; moving between them must not scroll ancestors.
    const longLeft = Array.from({ length: 180 }, (_, index) => `record-${String(index + 1).padStart(3, '0')}: original`);
    const longRight = [...longLeft];
    longRight[4] = 'record-005: modified-first';
    longRight[130] = 'record-131: modified-second';
    await compare(longLeft.join('\n'), longRight.join('\n'));
    await expectKinds(longLeft.map((_, index) => index === 4 || index === 130 ? 'change' : 'same'));
    await expectPosition(1, 2);
    await button('收起输入').click();
    assert.equal(await leftInput.isVisible(), false);
    assert.equal(await rightInput.isVisible(), false);
    await button('展开输入').waitFor();
    await expectContainedLayout(1280);
    const fixedHeight = (await scroll.boundingBox()).height;
    await scroll.evaluate((element) => { element.scrollTop = 0; element.scrollLeft = 0; });
    const beforeNext = await outerScrollSnapshot();
    await button('下一处差异').click();
    await expectPosition(2, 2);
    await expectRowInScroll(130);
    const secondScrollTop = await scroll.evaluate((element) => element.scrollTop);
    assert.ok(secondScrollTop > 0, 'Next difference scrolls the comparison');
    assert.deepEqual(await outerScrollSnapshot(), beforeNext, 'Next difference leaves outer scrolling unchanged');
    const beforePrevious = await outerScrollSnapshot();
    await button('上一处差异').click();
    await expectPosition(1, 2);
    await expectRowInScroll(4);
    assert.ok(await scroll.evaluate((element) => element.scrollTop) < secondScrollTop);
    assert.deepEqual(await outerScrollSnapshot(), beforePrevious, 'Previous difference leaves outer scrolling unchanged');
    await page.screenshot({ path: path.join(output, 'diff-navigation-1280.png'), fullPage: true });

    // More rows and an unbroken long line must not grow the comparison or the page width.
    const wideLeft = Array.from({ length: 260 }, (_, index) => `item-${index}: ${'long_content_'.repeat(50)}`);
    const wideRight = [...wideLeft];
    wideRight[150] += 'changed';
    await compare(wideLeft.join('\n'), wideRight.join('\n'));
    await expectKinds(wideLeft.map((_, index) => index === 150 ? 'change' : 'same'));
    await button('收起输入').click();
    assert.ok(Math.abs((await scroll.boundingBox()).height - fixedHeight) <= 2,
      'Collapsed result height does not grow when the row count increases');
    for (const width of [1280, 1024, 760]) {
      await page.setViewportSize({ width, height: 800 });
      await expectContainedLayout(width);
      await page.screenshot({ path: path.join(output, `diff-responsive-${width}.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await button('展开输入').click();
    assert.equal(await leftInput.isVisible(), true);
    assert.equal(await rightInput.isVisible(), true);
    await button('清空文本').click();
    assert.equal(await leftInput.inputValue(), '');
    assert.equal(await rightInput.inputValue(), '');
    await page.waitForFunction(() => document.querySelectorAll('[data-diff-row]').length === 0);

    // Reject oversized input explicitly and leave the pasted source intact.
    for (const oversized of ['x'.repeat(200001), Array(3001).fill('line').join('\n')]) {
      // Recover through the real UI between independent validation cases.
      await button('清空文本').click();
      assert.equal(await leftInput.inputValue(), '');
      assert.equal(await rightInput.inputValue(), '');
      assert.equal(await page.getByRole('alert').count(), 0, 'Clear recovers from validation errors');
      if (oversized.split('\n').length > 3000) {
        // In this Edge environment fill(3001 lines) inserts the entire value and
        // updates React, but its browser insertion command exceeds the timeout.
        // Bypass that insertion command only for this synthetic validator boundary;
        // a native value setter + bubbling input still exercises the real UI handler.
        // This covers the React guard, not the full Chromium Input.insertText path.
        await leftInput.evaluate((element, value) => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, oversized);
        await rightInput.fill('valid');
      } else {
        await setPair(oversized, 'valid');
      }
      await button('开始比较').click();
      await page.getByRole('alert').filter({ hasText: '最多比较' }).waitFor();
      assert.ok(await leftInput.inputValue() === oversized, 'Oversized pasted source is preserved without truncation');
      assert.equal(await button('复制差异').isDisabled(), true);
    }
    await button('清空文本').click();
    await setPair('before', 'after');
    await rightInput.press('Control+Enter');
    await expectKinds(['change']);
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await button('复制差异').click();
    await page.getByText('无法访问剪贴板，请在对照区选择文字后复制。', { exact: true }).waitFor();
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log('PASS: text diff alignment, inline marks, statistics, safe copy, filtering, dirty state, whitespace, actions, grouped navigation, contained scrolling, 1280/1024/760px layouts, input limits, keyboard comparison, and clipboard rejection.');
    console.log(`Screenshots: ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  // Playwright call logs can repeat synthetic 200k-character fill values; keep failures readable.
  const message = String(error.message || error).split('\nCall log:')[0];
  console.error(`${error.name || 'Error'}: ${message.slice(0, 1500)}`);
  process.exitCode = 1;
});
