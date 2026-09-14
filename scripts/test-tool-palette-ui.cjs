/** Tool-only paint regression: isolated browser, no native host or user data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sass = require(path.join(root, 'frontend/node_modules/sass'));
const postcss = require(path.join(root, 'frontend/node_modules/postcss'));
const styleFiles = [
  // The unified network workbench intentionally changes layout; its responsive
  // geometry is covered by the network workspace tests rather than this guard.
  ...['DatabaseStudio', 'ImageToolbox', 'Toolbox', 'SerialDebugger',
    'MqttDebugger', 'ModbusDebugger', 'UtilityCodecWorkspace', 'UtilitySpecializedWorkspace',
    'TextDiffWorkspace', 'RegexWorkspace'].map((name) => `frontend/src/toolbox/${name}.module.scss`),
  'shared/packet-inspector/PacketWorkbench.module.scss',
  'shared/tool-workspace/ToolWorkspaceHeader.module.scss',
];

function geometry(source, file) {
  const css = sass.compileString(source, { url: pathToFileURL(path.join(root, file)), logger: sass.Logger.silent }).css;
  const rules = new Map();
  postcss.parse(css).walkDecls((decl) => {
    const prop = decl.prop;
    if (/^(color|background(?:-color|-image)?|box-shadow|text-shadow|caret-color|accent-color|fill|stroke|opacity|-webkit-text-fill-color)$/.test(prop)
      || /-color$/.test(prop) || /^--(?:tool-|theme-(?:ink|muted|paper|sand)$)/.test(prop)) return;
    let value = decl.value;
    if (/^(?:border(?:-top|-right|-bottom|-left|-block|-inline)?|outline)$/.test(prop)) {
      const edges = value.match(/^(?:0|none|(?:\d*\.?\d+(?:px|em|rem)|thin|medium|thick))(?:\s+(?:solid|dotted|dashed|double|none|hidden))?/);
      assert.ok(edges, `unsupported border shorthand: ${file}: ${value}`);
      value = edges[0];
    }
    const ancestry = [];
    for (let node = decl.parent; node && node.type !== 'root'; node = node.parent) {
      ancestry.unshift(node.type === 'rule' ? node.selector : `@${node.name} ${node.params}`);
    }
    const key = ancestry.join(' > ');
    if (!rules.has(key)) rules.set(key, new Map());
    rules.get(key).set(prop, `${value}${decl.important ? ' !important' : ''}`);
  });
  return [...rules].sort(([a], [b]) => a.localeCompare(b)).map(([key, props]) => [key, [...props].sort(([a], [b]) => a.localeCompare(b))]);
}

(async () => {
  for (const file of styleFiles) {
    const before = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' });
    const after = fs.readFileSync(path.join(root, file), 'utf8');
    assert.deepEqual(geometry(after, file), geometry(before, file), `${file}: only paint may change; preserve all layout/font/scroll declarations`);
  }
  console.log(`PASS paint-only guard: ${styleFiles.length} styles preserve layout, font, sizing and scrolling declarations.`);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const output = path.join(root, 'artifacts/tool-palette');
  fs.mkdirSync(output, { recursive: true });
  const unchanged = new Set(['系统中心', '端口管理', '软件卸载']);
  const header = () => page.locator('header[aria-label="工具详情导航"]');
  const main = () => page.getByRole('main').last();
  const sidebar = () => page.getByRole('complementary').first();
  const snapshotSidebar = () => sidebar().evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor, width: el.getBoundingClientRect().width };
  });
  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:18779/?mode=dashboard');
    await page.getByRole('button', { name: /^工具首页/ }).click();
    const names = await page.getByRole('article').filter({ has: page.getByRole('button', { name: '打开', exact: true }) }).locator('h3').allTextContents();
    assert.equal(names.length, 20);
    assert.equal(names.filter((name) => name === '网络调试助手').length, 1);
    assert.equal(names.includes('发包工具'), false);
    for (const theme of ['apricot', 'cloud', 'rose']) {
      await page.evaluate((theme) => { document.documentElement.dataset.workspaceTheme = theme; }, theme);
      const sidebarBefore = await snapshotSidebar();
      for (const name of names) {
        await page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: '打开', exact: true }).click();
        await header().waitFor();
        if (!unchanged.has(name)) {
          const title = header().getByRole('heading');
          assert.equal(await title.evaluate((el) => getComputedStyle(el).color), 'rgb(36, 53, 74)', `${theme}/${name}: slate-blue tool title`);
          const contrast = await main().evaluate((area) => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const rgba = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
            const luminance = (rgb) => rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const values = [];
            // Solid primary buttons and headers: disabled controls are intentionally subdued.
            for (const el of area.querySelectorAll('button,h2,h3')) {
              if (el.disabled || !el.getClientRects().length) continue;
              const style = getComputedStyle(el);
              if (Number(style.opacity) < 1) continue;
              const fg = rgba(style.color);
              const bg = rgba(style.backgroundColor);
              if (el.tagName === 'BUTTON' && fg.slice(0, 3).every((c) => c > 245) && bg[3] === 255) {
                const ratio = (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
                values.push({ label: el.textContent.trim(), ratio });
              }
            }
            return values;
          });
          for (const item of contrast) assert.ok(item.ratio >= 4.5, `${theme}/${name}/${item.label}: white action text contrast ${item.ratio}`);
          if (name === 'Base64') {
            const input = page.getByRole('region', { name: '输入区域' });
            const result = page.getByRole('region', { name: '输出区域' });
            assert.notEqual(await input.locator('header').evaluate((el) => getComputedStyle(el).backgroundColor), await result.locator('header').evaluate((el) => getComputedStyle(el).backgroundColor), 'input and output are visually distinct');
          }
          if (['JSON 格式化', '网络调试助手', '数据库工作台', '图片转换器', '十六进制报文分析器', '文本比较'].includes(name)) {
            await page.screenshot({ path: path.join(output, `${name}-${theme}.png`), fullPage: true, animations: 'disabled' });
          }
        }
        assert.deepEqual(await snapshotSidebar(), sidebarBefore, `${theme}/${name}: tool colors cannot leak into the sidebar`);
        await header().getByRole('button', { name: '← 返回工具列表', exact: true }).click();
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS palette UI: all 20 tools / 3 themes open; 17 palette-aligned titles, readable solid actions, distinct input/output and unchanged sidebar. Synthetic preview only.');
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
