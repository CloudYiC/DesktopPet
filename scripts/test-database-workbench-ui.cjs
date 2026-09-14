/** Database workbench UI regression with an in-memory WebView2 bridge; never opens or writes a real database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const listeners = new Set();
    const columns = [
      { name: 'id', type: 'INTEGER', defaultValue: '', notNull: true, primaryKey: true },
      { name: 'name', type: 'TEXT', defaultValue: "'untitled'", notNull: true, primaryKey: false },
      { name: 'notes', type: 'TEXT', defaultValue: '', notNull: false, primaryKey: false },
    ];
    const overview = {
      path: 'C:\\SyntheticFixture\\cloudyi-workbench-test.sqlite3',
      fileName: 'cloudyi-workbench-test.sqlite3', fileSizeBytes: 1048576,
      pageSize: 4096, pageCount: 256, userVersion: 1, journalMode: 'wal',
      objects: [
        ...Array.from({ length: 60 }, (_, index) => {
          const name = `sample_${String(index + 1).padStart(2, '0')}`;
          return { type: 'table', name, tableName: name,
            sql: `CREATE TABLE "${name}" (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'untitled', notes TEXT)`,
            columns: index === 25 ? [...columns, { name: 'distinctive_field', type: 'TEXT', defaultValue: '', notNull: false, primaryKey: false }] : columns };
        }),
        { type: 'view', name: 'active_samples', tableName: 'active_samples', sql: 'CREATE VIEW active_samples AS SELECT * FROM sample_01', columns },
        { type: 'index', name: 'idx_sample_name', tableName: 'sample_01', sql: 'CREATE INDEX idx_sample_name ON sample_01(name)', columns: [] },
        { type: 'trigger', name: 'sample_audit', tableName: 'sample_01', sql: 'CREATE TRIGGER sample_audit AFTER INSERT ON sample_01 BEGIN SELECT 1; END', columns: [] },
      ],
    };
    const state = window.__dbFixture = {
      requests: [], clipboard: [],
      failNext: '', cancelledNextPick: false, delay: 100, rows: 200,
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { state.clipboard.push(String(text)); },
    } });
    const bridge = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: (request) => {
        state.requests.push(request);
        if (!request.type.startsWith('database.')) return;
        const payload = request.payload || {};
        const error = state.failNext;
        state.failNext = '';
        const cancelled = state.cancelledNextPick;
        state.cancelledNextPick = false;
        setTimeout(() => {
          let response = {};
          let message = error;
          if (request.type === 'database.pick') {
            response = cancelled ? { cancelled: true } : { cancelled: false, overview: payload.createNew ? { ...overview, fileName: 'new-empty.sqlite3', objects: [] } : overview };
          } else if (request.type === 'database.refresh') {
            response = { overview };
          } else if (request.type === 'database.execute') {
            const sql = String(payload.sql).trim();
            const write = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql);
            if (sql.includes('INVALID_SQL')) message = '模拟 SQL 语法错误';
            if (write && !payload.allowWrite) message = '只读模式拒绝写入';
            const fields = ['id', 'name', 'notes', ...Array.from({ length: 8 }, (_, index) => `detail_${index + 1}`)];
            const data = Array.from({ length: state.rows }, (_, index) => [String(index + 1), `合成记录 ${index + 1}`, index === 0 ? 'contains\ttab\nand newline' : index === 1 ? 'NULL' : `note-${index + 1}`,
              ...Array.from({ length: 8 }, (_, column) => `column-${column + 1}-${'sample-data-'.repeat(5)}`)]);
            response = { result: {
              columns: write ? [] : fields, rows: write ? [] : data,
              affectedRows: write ? 1 : 0, lastInsertId: write ? 3 : 0,
              elapsedMilliseconds: 12, statementCount: 1, truncated: state.rows >= 500,
              wroteData: write, message: write ? '执行完成，影响 1 行。' : `查询完成，返回 ${state.rows} 行。`,
            }, ...(write ? { overview } : {}) };
          }
          const event = { data: { type: `${request.type}.${message ? 'error' : 'result'}`,
            payload: { requestId: payload.requestId, ...(message ? { message } : response) } } };
          listeners.forEach((listener) => listener(event));
        }, state.delay);
      },
    };
    if (!window.chrome) window.chrome = {};
    window.chrome.webview = bridge;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const runtimeErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  const output = path.resolve(__dirname, '../artifacts/database-workbench');
  fs.mkdirSync(output, { recursive: true });
  const button = (name) => name === '运行 SQL'
    ? page.getByRole('button', { name: /运行 SQL/ })
    : page.getByRole('button', { name, exact: true });
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  const workspace = page.getByTestId('db-workspace');
  const schema = page.getByRole('complementary', { name: '数据库结构', exact: true });
  const schemaScroll = page.getByTestId('db-schema-scroll');
  const editor = page.getByRole('textbox', { name: 'SQL 编辑器', exact: true });
  const editorPane = page.getByTestId('db-sql-editor');
  const resultScroll = page.getByTestId('db-result-scroll');
  const footer = page.getByTestId('db-results-footer');
  const separator = page.getByRole('separator', { name: '调整编辑区高度', exact: true });
  const readOnly = page.getByRole('switch', { name: '只读模式', exact: true });

  async function requestCount(type) {
    return page.evaluate((type) => window.__dbFixture.requests.filter((request) => request.type === type).length, type);
  }
  async function setFixture(value) {
    return page.evaluate((value) => Object.assign(window.__dbFixture, value), value);
  }
  async function run(sql, approveWrite = false) {
    await tab('SQL 查询').click();
    await editor.fill(sql);
    await button('运行 SQL').click();
    if (approveWrite) await page.getByRole('dialog', { name: '确认执行 SQL', exact: true }).getByRole('button', { name: '确认执行', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((element) => element.textContent.includes('运行 SQL') && !element.disabled));
  }
  async function expectCenteredDialog(dialog) {
    await dialog.waitFor();
    const geometry = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(Math.abs(geometry.x + geometry.width / 2 - geometry.viewportWidth / 2) < 2, 'Dialog centers in whole client horizontally');
    assert.ok(Math.abs(geometry.y + geometry.height / 2 - geometry.viewportHeight / 2) < 2, 'Dialog centers in whole client vertically');
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((element) => document.activeElement === element), true, 'Default focus is cancel, not a write action');
  }
  async function expectLayout(width, height) {
    const geometry = await workspace.evaluate((element) => {
      const ancestors = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/auto|scroll/.test(style.overflowY)) ancestors.push({ tag: node.tagName, height: node.clientHeight, scrollHeight: node.scrollHeight });
      }
      return { documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth, documentHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight, ancestors };
    });
    assert.ok(geometry.documentWidth <= width + 1 && geometry.bodyWidth <= width + 1,
      `No document horizontal overflow at ${width}x${height}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.documentHeight <= height + 1 && geometry.bodyHeight <= height + 1,
      `No document vertical overflow at ${width}x${height}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.ancestors.every((node) => node.scrollHeight <= node.height + 2),
      `No outer workbench scrolling at ${width}x${height}: ${JSON.stringify(geometry.ancestors)}`);
    for (const [name, locator] of [['workspace', workspace], ['schema', schema], ['SQL editor', editorPane], ['results', resultScroll], ['result footer', footer]]) {
      const box = await locator.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
        `${name} stays visible at ${width}x${height}: ${JSON.stringify(box)}`);
    }
    const rightBox = await editorPane.boundingBox();
    const leftBox = await schema.boundingBox();
    assert.ok(leftBox.x + leftBox.width <= rightBox.x + 1, 'Structure tree remains left of the editor');
    assert.ok((await resultScroll.boundingBox()).height >= 80, 'Result area remains usable');
  }

  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await page.getByRole('button', { name: /^工具首页/ }).click();
    const cards = page.getByRole('article').filter({ has: page.getByRole('button', { name: '打开', exact: true }) });
    assert.equal(await cards.count(), 21, 'Number Format stays removed; native debuggers and Packet Sender are available');
    assert.equal(await page.getByRole('heading', { name: '数字格式化', exact: true }).count(), 0);
    const card = cards.filter({ has: page.getByRole('heading', { name: '数据库工作台', exact: true }) });
    const description = await card.locator('p').innerText();
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('header[aria-label="工具详情导航"]').getByRole('heading', { name: '数据库工作台', exact: true }).waitFor();
    assert.equal((await page.getByRole('main').last().innerText()).includes(description), false, 'Tool description remains catalog-only');
    await button('打开数据库').click();
    await workspace.waitFor();
    await editor.waitFor();
    assert.equal(await readOnly.getAttribute('aria-checked'), 'true', 'Database opens read-only');
    for (const title of ['SQL 查询', '表结构', '建表语句', '查询结果', '执行信息']) assert.equal(await tab(title).count(), 1, `${title} is accessible as a tab`);
    assert.equal(await button('复制结果').isDisabled(), true, 'Cannot copy before a query');
    await expectLayout(1280, 800);

    const tableGroup = schemaScroll.locator('button[aria-expanded]').first();
    await tableGroup.click();
    assert.equal(await schema.getByRole('button', { name: '选择 sample_01', exact: true }).count(), 0, 'Collapsing the table group hides its objects');
    await tableGroup.click();
    for (const [group, object] of [['视图', 'active_samples'], ['索引', 'idx_sample_name'], ['触发器', 'sample_audit']]) {
      await schemaScroll.getByRole('button').filter({ hasText: group }).click();
      await schema.getByRole('button', { name: `选择 ${object}`, exact: true }).click();
      await tab('建表语句').click();
      await page.locator('pre').filter({ hasText: new RegExp(`CREATE (VIEW|INDEX|TRIGGER) ${object}`) }).waitFor();
      await tab('SQL 查询').click();
    }
    const expandedWidth = (await editorPane.boundingBox()).width;
    await button('收起数据库结构').click();
    assert.ok((await editorPane.boundingBox()).width > expandedWidth + 70, 'Collapsing the schema gives space to query details');
    assert.equal(await schemaScroll.count(), 0);
    await button('展开数据库结构').click();
    await schemaScroll.evaluate((element) => { element.scrollTop = 0; });

    // Searching includes field names and does not mutate the database.
    const filter = schema.getByRole('textbox');
    await filter.fill('distinctive_field');
    await schema.getByRole('button').filter({ hasText: 'sample_26' }).waitFor();
    assert.equal(await schema.getByRole('button').filter({ hasText: 'sample_01' }).count(), 0);
    await filter.fill('not_present_anywhere');
    assert.equal(await schema.getByRole('button').filter({ hasText: 'sample_26' }).count(), 0);
    await filter.fill('');
    await editor.fill('SELECT \'unsaved query\';');
    await schema.getByRole('button', { name: '选择 sample_01', exact: true }).click();
    await tab('表结构').click();
    await page.getByRole('cell', { name: 'INTEGER', exact: true }).waitFor();
    await tab('建表语句').click();
    await page.getByText(/CREATE TABLE "sample_01"/).waitFor();
    await tab('SQL 查询').click();
    assert.equal(await editor.inputValue(), 'SELECT \'unsaved query\';', 'Object browsing does not replace unfinished SQL');
    await run('SELECT * FROM sample_01 LIMIT 200;');
    await resultScroll.getByRole('cell', { name: '合成记录 1', exact: true }).waitFor();
    assert.ok(await resultScroll.getByRole('cell', { name: 'NULL', exact: true }).count() > 0);
    await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });

    await button('复制结果').click();
    await page.waitForFunction(() => window.__dbFixture.clipboard.length === 1);
    const copied = await page.evaluate(() => window.__dbFixture.clipboard[0]);
    assert.ok(copied.startsWith('id\tname\tnotes\t'), 'TSV includes column headings');
    assert.match(copied, /合成记录 1/);
    assert.ok(copied.includes('"contains\ttab\nand newline"'), 'TSV quotes cells containing tabs/newlines');
    await tab('执行信息').click();
    assert.match(await workspace.innerText(), /12\s*ms/);
    await tab('查询结果').click();

    // Scroll each pane independently without moving the application content.
    const beforeBounds = await editorPane.boundingBox();
    const schemaMetrics = await schemaScroll.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    assert.ok(schemaMetrics.scroll > schemaMetrics.client + 20);
    assert.match(schemaMetrics.overflow, /auto|scroll/);
    await schemaScroll.evaluate((element) => { element.scrollTop = 400; });
    assert.ok(await schemaScroll.evaluate((element) => element.scrollTop) > 0);
    await resultScroll.evaluate((element) => { element.scrollTop = 600; element.scrollLeft = 300; });
    assert.ok(await resultScroll.evaluate((element) => element.scrollTop) > 0);
    assert.ok(await resultScroll.evaluate((element) => element.scrollLeft) > 0);
    assert.deepEqual(await editorPane.boundingBox(), beforeBounds, 'Pane scrolling leaves SQL controls fixed');

    // The splitter supports keyboard and pointer use, and remains bounded.
    const oldHeight = (await editorPane.boundingBox()).height;
    await separator.focus();
    await separator.press('ArrowDown');
    assert.ok((await editorPane.boundingBox()).height > oldHeight, 'ArrowDown expands the editor');
    await separator.press('ArrowUp');
    const split = await separator.boundingBox();
    await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
    await page.mouse.down();
    await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2 + 35, { steps: 4 });
    await page.mouse.up();
    assert.ok((await editorPane.boundingBox()).height > oldHeight + 20, 'Pointer drag changes editor/result split');
    await expectLayout(1280, 800);

    for (const height of [800, 600]) {
      for (const width of [1280, 1024, 760]) {
        await page.setViewportSize({ width, height });
        await expectLayout(width, height);
        await page.screenshot({ path: path.join(output, `responsive-${width}x${height}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Syntax colors, caret and line numbers must align at both scroll limits.
    await editor.fill(Array.from({ length: 80 }, (_, index) => `SELECT ${index + 1}, '${'synthetic-long-value-'.repeat(25)}';`).join('\n'));
    const syntaxScroll = await editor.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.scrollLeft = element.scrollWidth;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      const highlight = element.parentElement.querySelector('pre');
      const gutter = element.parentElement.parentElement.querySelector('pre');
      return { inputLeft: element.scrollLeft, inputTop: element.scrollTop,
        highlightLeft: highlight.scrollLeft, highlightTop: highlight.scrollTop, gutterTop: gutter.scrollTop };
    });
    assert.ok(syntaxScroll.inputLeft > 0 && syntaxScroll.inputTop > 0, 'Synthetic SQL scrolls in both directions');
    assert.ok(Math.abs(syntaxScroll.inputLeft - syntaxScroll.highlightLeft) <= 1 && Math.abs(syntaxScroll.inputTop - syntaxScroll.highlightTop) <= 1,
      `SQL highlighting follows the caret at maximum scrolling: ${JSON.stringify(syntaxScroll)}`);
    assert.ok(Math.abs(syntaxScroll.inputTop - syntaxScroll.gutterTop) <= 1, 'SQL line numbers follow vertical scrolling');

    // A synchronous duplicate keyboard shortcut must not send concurrent requests.
    await setFixture({ delay: 350 });
    await editor.fill('SELECT * FROM sample_01;');
    const beforeDouble = await requestCount('database.execute');
    await editor.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await page.waitForFunction((count) => window.__dbFixture.requests.filter((request) => request.type === 'database.execute').length > count, beforeDouble);
    assert.equal(await requestCount('database.execute'), beforeDouble + 1, 'Duplicate Ctrl+Enter sends one request');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((element) => element.textContent.includes('运行 SQL') && !element.disabled));
    await setFixture({ delay: 100 });

    await run('INVALID_SQL');
    await page.getByRole('alert').filter({ hasText: '模拟 SQL 语法错误' }).waitFor();
    assert.equal(await button('复制结果').isDisabled(), true, 'Failed query cannot copy an older result');
    await run('DELETE FROM sample_01;');
    await page.getByRole('alert').filter({ hasText: '只读模式拒绝写入' }).waitFor();
    const readOnlyRequest = await page.evaluate(() => window.__dbFixture.requests.filter((request) => request.type === 'database.execute').at(-1));
    assert.equal(readOnlyRequest.payload.allowWrite, false, 'Read-only permission reaches the host');
    await readOnly.click();
    const enableDialog = page.getByRole('dialog', { name: '启用数据库写入？', exact: true });
    await expectCenteredDialog(enableDialog);
    const beforeEnableCancel = await requestCount('database.execute');
    await enableDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await requestCount('database.execute'), beforeEnableCancel, 'Cancelling write mode sends no SQL');
    assert.equal(await readOnly.getAttribute('aria-checked'), 'true', 'Rejecting write confirmation preserves read-only');
    await readOnly.click();
    await expectCenteredDialog(enableDialog);
    await page.screenshot({ path: path.join(output, 'enable-write-confirmation.png'), fullPage: true });
    await enableDialog.getByRole('button', { name: '启用写入', exact: true }).click();
    assert.equal(await readOnly.getAttribute('aria-checked'), 'false', 'Explicit approval enables write mode');
    await button('预览数据').click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((element) => element.textContent.includes('运行 SQL') && !element.disabled));
    const previewRequest = await page.evaluate(() => window.__dbFixture.requests.filter((request) => request.type === 'database.execute').at(-1));
    assert.equal(previewRequest.payload.allowWrite, false, 'Table preview always uses read-only host permission');
    assert.match(previewRequest.payload.sql, /SELECT \*\s+FROM "sample_01"\s+LIMIT 200;/);
    assert.equal(await page.getByRole('dialog').count(), 0, 'Safe table preview needs no write confirmation');
    const beforeCancelledWrite = await requestCount('database.execute');
    await button('运行 SQL').click();
    const executeDialog = page.getByRole('dialog', { name: '确认执行 SQL', exact: true });
    await expectCenteredDialog(executeDialog);
    await page.keyboard.press('Escape');
    await executeDialog.waitFor({ state: 'hidden' });
    assert.equal(await requestCount('database.execute'), beforeCancelledWrite, 'Rejecting execution confirmation sends nothing');
    const frozenSql = 'UPDATE sample_01 SET name = \'changed\';';
    await editor.fill(frozenSql);
    await button('运行 SQL').click();
    await expectCenteredDialog(executeDialog);
    assert.equal(await executeDialog.getByLabel('待执行 SQL').innerText(), frozenSql, 'Review shows the precise SQL to be executed');
    assert.match(await executeDialog.innerText(), /C:\\SyntheticFixture\\cloudyi-workbench-test.sqlite3/, 'Review shows the frozen database path');
    assert.equal(await button('打开数据库').isDisabled(), true, 'Database target cannot change during review');
    assert.equal(await button('关闭').isDisabled(), true);
    assert.equal(await editor.isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'execute-write-confirmation.png'), fullPage: true });
    // A shortcut during modal review must neither execute nor replace the frozen statement.
    await page.keyboard.press('Control+Enter');
    assert.equal(await requestCount('database.execute'), beforeCancelledWrite);
    await setFixture({ delay: 350 });
    await executeDialog.getByRole('button', { name: '确认执行', exact: true }).evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.keyboard.press('Escape');
    assert.equal(await executeDialog.isVisible(), true, 'Busy execution cannot be ambiguously cancelled');
    assert.equal(await executeDialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    assert.equal(await requestCount('database.execute'), beforeCancelledWrite + 1, 'Duplicate confirmation posts exactly one write');
    await page.getByText(/执行完成，影响 1 行/).first().waitFor();
    await executeDialog.waitFor({ state: 'hidden' });
    const writeRequest = await page.evaluate(() => window.__dbFixture.requests.filter((request) => request.type === 'database.execute').at(-1));
    assert.equal(writeRequest.payload.allowWrite, true, 'Approved write permission reaches the host');
    assert.equal(writeRequest.payload.sql, frozenSql, 'Approved SQL exactly matches the reviewed snapshot');
    await setFixture({ failNext: '模拟写入失败，结果不确定', delay: 100 });
    const beforeFailedWrite = await requestCount('database.execute');
    await run('UPDATE sample_01 SET name = \'review-again\';', true);
    await page.getByRole('alert').filter({ hasText: '模拟写入失败，结果不确定' }).waitFor();
    await executeDialog.waitFor({ state: 'hidden' });
    assert.equal(await requestCount('database.execute'), beforeFailedWrite + 1, 'Failed write does not retry automatically');
    await button('运行 SQL').click();
    await expectCenteredDialog(executeDialog);
    assert.equal(await requestCount('database.execute'), beforeFailedWrite + 1, 'Retry requires a new explicit review');
    await executeDialog.getByRole('button', { name: '取消', exact: true }).click();
    await readOnly.click();
    assert.equal(await readOnly.getAttribute('aria-checked'), 'true');

    // The native 500-row cap is clearly labelled and the DOM remains virtualized.
    await setFixture({ rows: 500 });
    await run('SELECT * FROM sample_01;');
    assert.match(await footer.innerText(), /500 行/);
    assert.match(await footer.innerText(), /截断/);
    assert.ok(await resultScroll.getByRole('row').count() < 100, 'Large query results mount only visible rows plus overscan');
    await resultScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; element.scrollLeft = 0; });
    await resultScroll.getByRole('cell', { name: '合成记录 500', exact: true }).waitFor();
    await expectLayout(1280, 800);
    await setFixture({ rows: 200 });

    const oversizedSql = `SELECT '${'测'.repeat(90000)}';`;
    await editor.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, oversizedSql);
    assert.equal(await editor.inputValue(), oversizedSql, 'Oversized SQL is preserved intact');
    assert.equal(await button('运行 SQL').isDisabled(), true, 'The SQL limit measures UTF-8 bytes, not just characters');
    const beforeOversized = await requestCount('database.execute');
    await editor.press('Control+Enter');
    assert.equal(await requestCount('database.execute'), beforeOversized, 'Keyboard cannot bypass the SQL byte limit');
    await run('SELECT * FROM sample_01 LIMIT 200;');

    await setFixture({ failNext: '模拟刷新失败' });
    await button('刷新结构').click();
    await page.getByRole('alert').filter({ hasText: '模拟刷新失败' }).waitFor();
    await button('刷新结构').click();
    await page.getByRole('alert').filter({ hasText: '模拟刷新失败' }).waitFor({ state: 'hidden' });
    await setFixture({ cancelledNextPick: true });
    await button('打开数据库').click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((element) => element.textContent === '打开数据库' && !element.disabled));
    assert.ok(await page.getByText('cloudyi-workbench-test.sqlite3', { exact: true }).count() > 0, 'Cancelled picker keeps the current connection');
    await setFixture({ failNext: '模拟关闭失败' });
    await button('关闭').click();
    await page.getByRole('alert').filter({ hasText: '模拟关闭失败' }).waitFor();
    assert.equal(await workspace.isVisible(), true, 'Failed close preserves the workspace');
    await button('关闭').click();
    await editor.waitFor({ state: 'hidden' });
    await button('新建数据库').click();
    await page.getByText('new-empty.sqlite3', { exact: true }).waitFor();
    assert.equal(await readOnly.getAttribute('aria-checked'), 'true', 'New connections reset to read-only');
    assert.equal(await button('复制结果').isDisabled(), true, 'New database discards previous query results');
    await expectLayout(1280, 800);
    assert.deepEqual(runtimeErrors, [], 'No uncaught browser errors');
    assert.deepEqual(nativeDialogs, [], 'No browser-native alert or confirm dialogs');
    console.log('PASS: 21-tool catalog, database rename, synthetic native bridge, grouped schema/search, structure/DDL tabs, results/TSV, split resize, independent scrolling, six viewport sizes, duplicate-query guard, errors, read-only/write confirmations, connection cancellation/close/new.');
    console.log(`Screenshots: ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(String(error.stack || error).slice(0, 5000)); process.exitCode = 1; });
