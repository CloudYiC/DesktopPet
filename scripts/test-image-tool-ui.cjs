/** Image conversion regression: synthetic pixels only, isolated browser, no host saves. */
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
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const downloads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const outputDirectory = path.resolve(__dirname, '../artifacts/image-tool');
  fs.mkdirSync(outputDirectory, { recursive: true });

  const button = (name) => page.getByRole('button', { name, exact: true });
  const sourceImage = page.getByRole('img', { name: '原图预览', exact: true });
  const resultImage = page.getByRole('img', { name: '转换结果预览', exact: true });
  const controls = page.getByTestId('image-controls');
  const preview = page.getByTestId('image-preview');
  const mode = page.getByRole('combobox', { name: '背景处理', exact: true });
  const widthInput = page.getByRole('spinbutton', { name: '宽度', exact: true });
  const heightInput = page.getByRole('spinbutton', { name: '高度', exact: true });
  const aspect = button('保持比例');
  const sourceColor = page.getByLabel('原背景色', { exact: true });
  const saveButton = button('转换并保存');

  async function currentResultUrl() {
    return await resultImage.count() ? await resultImage.getAttribute('src') : null;
  }

  async function waitForResult({ previousUrl, width, height, mime } = {}) {
    await page.waitForFunction(({ previousUrl, width, height, mime }) => {
      const image = document.querySelector('img[alt="转换结果预览"]');
      const save = [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === '转换并保存');
      return image && image.complete && image.naturalWidth > 0 &&
        (previousUrl === undefined || image.getAttribute('src') !== previousUrl) &&
        (width === undefined || image.naturalWidth === width) &&
        (height === undefined || image.naturalHeight === height) &&
        (!mime || image.src.startsWith(`data:${mime};base64,`)) && save && !save.disabled;
    }, { previousUrl, width, height, mime });
  }

  // Require a genuinely new decoded result after every pixel-changing action.
  // Never read an old preview while its replacement is still being generated.
  async function changeResult(action, expected = {}) {
    const previousUrl = await currentResultUrl();
    await action();
    await waitForResult({ previousUrl, ...expected });
  }

  async function chooseFile(file, expected) {
    const previousSource = await sourceImage.count() ? await sourceImage.getAttribute('src') : null;
    const previousUrl = await currentResultUrl();
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.waitForFunction((previous) => {
      const image = document.querySelector('img[alt="原图预览"]');
      return image && image.complete && image.naturalWidth > 0 && image.getAttribute('src') !== previous;
    }, previousSource);
    await waitForResult({ previousUrl, ...expected });
  }

  async function pixels(points, image = resultImage) {
    return image.evaluate((element, coordinates) => {
      if (!element.complete || !element.naturalWidth) throw new Error('Preview image is not decoded');
      const canvas = document.createElement('canvas');
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(element, 0, 0);
      return coordinates.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    }, points);
  }

  function near(actual, expected, tolerance = 2) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= tolerance,
      `Pixel ${JSON.stringify(actual)} should be near ${JSON.stringify(expected)} (tolerance ${tolerance})`));
  }

  async function setNativeInput(locator, value) {
    // Chromium cannot fill() color/range controls. Dispatch the native input event
    // through React's real handler without touching any app state or host API.
    await locator.evaluate((element, next) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, next);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
    assert.equal(await locator.inputValue(), String(value));
  }

  async function screenshot(name) {
    await page.screenshot({ path: path.join(outputDirectory, name), fullPage: true });
  }

  async function assertViewportContained(width, height) {
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    assert.equal(layout.width, width);
    assert.ok(layout.documentWidth <= width + 1 && layout.bodyWidth <= width + 1,
      `No horizontal document overflow at ${width} x ${height}: ${JSON.stringify(layout)}`);
    for (const [name, locator] of [['preview', preview], ['save button', saveButton]]) {
      const bounds = await locator.boundingBox();
      assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${name} exists at ${width} x ${height}`);
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y >= -1 && bounds.y + bounds.height <= height + 1,
        `${name} remains fully in the ${width} x ${height} viewport: ${JSON.stringify(bounds)}`);
    }
  }

  async function assertIndependentScrolling(width, height) {
    await page.setViewportSize({ width, height });
    await controls.evaluate((element) => { element.scrollTop = 0; });
    await assertViewportContained(width, height);
    const before = await preview.boundingBox();
    const controlBounds = await controls.boundingBox();
    assert.ok(controlBounds.x + controlBounds.width <= before.x + 2,
      `Settings stay to the left of preview at ${width} x ${height}`);
    if (height === 600) {
      for (const [name, locator] of [['width', widthInput], ['height', heightInput]]) {
        await locator.scrollIntoViewIfNeeded();
        const bounds = await locator.boundingBox();
        assert.ok(bounds && bounds.y >= controlBounds.y - 1 && bounds.y + bounds.height <= controlBounds.y + controlBounds.height + 1,
          `${name} field is reachable by scrolling settings in a 600px-high window`);
        const stillFixed = await preview.boundingBox();
        for (const property of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(before[property] - stillFixed[property]) <= 1,
            `Reaching ${name} must not move preview ${property} at ${width} x ${height}`);
        }
        await assertViewportContained(width, height);
      }
    }
    const metrics = await controls.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      };
    });
    assert.match(metrics.overflowY, /^(auto|scroll)$/, 'Settings owns vertical scrolling');
    assert.ok(metrics.scrollTop > 0 && metrics.scrollHeight > metrics.clientHeight,
      `Settings has an independently scrollable overflow at ${width} x ${height}: ${JSON.stringify(metrics)}`);
    const after = await preview.boundingBox();
    for (const property of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(before[property] - after[property]) <= 1,
        `Preview ${property} is fixed while settings scroll at ${width} x ${height}`);
    }
    await assertViewportContained(width, height);
    await screenshot(`responsive-${width}x${height}.png`);
    await controls.evaluate((element) => { element.scrollTop = 0; });
  }

  try {
    await page.goto(process.env.PACKET_TEST_URL || 'http://127.0.0.1:3002/?mode=dashboard');
    await page.getByRole('button', { name: /^工具首页/ }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '图片转换器', exact: true }) });
    await card.getByRole('button', { name: '打开', exact: true }).click();
    await button('选择图片').waitFor();
    assert.match(await page.locator('input[type="file"]').getAttribute('accept'), /image\/png/);

    // Fixture buffers are made from browser canvas; no personal files are read.
    const fixtures = await page.evaluate(() => {
      function png(width, height, draw) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        draw(canvas.getContext('2d'));
        return canvas.toDataURL('image/png').split(',')[1];
      }
      return {
        opaque: png(120, 80, (context) => {
          context.fillStyle = '#2457d6';
          context.fillRect(0, 0, 120, 80);
          context.fillStyle = '#df302c';
          context.fillRect(30, 20, 60, 40);
          // Enclosed same-blue subject detail must not join the border flood mask.
          context.fillStyle = '#2457d6';
          context.fillRect(50, 30, 20, 20);
        }),
        transparent: png(80, 60, () => {}),
      };
    });
    const opaqueFile = { name: 'synthetic-blue-background.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.opaque, 'base64') };
    const transparentFile = { name: 'synthetic-transparent.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.transparent, 'base64') };
    const blue = [36, 87, 214, 255];
    const redSubject = [223, 48, 44, 255];
    const samplePoints = [[8, 8], [35, 25], [60, 40]];
    await chooseFile(opaqueFile, { width: 120, height: 80, mime: 'image/png' });
    await page.getByRole('complementary', { name: '图片设置', exact: true }).waitFor();
    await page.getByRole('region', { name: '图片预览', exact: true }).waitFor();
    assert.equal(await mode.locator('option:checked').innerText(), '保留原背景');
    assert.equal(await aspect.getAttribute('aria-pressed'), 'true');
    (await pixels(samplePoints)).forEach((pixel, index) => near(pixel, [blue, redSubject, blue][index]));

    await changeResult(() => mode.selectOption({ label: '替换纯色背景' }), { width: 120, height: 80 });
    for (const name of ['白色', '蓝色', '红色', '透明', '从原图取色', '自动取色']) {
      assert.equal(await button(name).count(), 1, `${name} is uniquely accessible`);
    }
    for (const label of ['颜色容差', '边缘柔化']) {
      assert.equal(await page.getByRole('slider', { name: label, exact: true }).count(), 1);
    }
    // Set deterministic segmentation before checking exact, unsoftened pixels.
    await setNativeInput(page.getByRole('slider', { name: '颜色容差', exact: true }), 0);
    await setNativeInput(page.getByRole('slider', { name: '边缘柔化', exact: true }), 0);
    await button('白色').click();
    await waitForResult();
    let samples = await pixels(samplePoints);
    near(samples[0], [255, 255, 255, 255]);
    near(samples[1], redSubject);
    near(samples[2], blue);
    await screenshot('overview.png');

    // Source pixels are never overwritten; the closed blue interior is preserved.
    (await pixels(samplePoints, sourceImage)).forEach((pixel, index) => near(pixel, [blue, redSubject, blue][index]));
    await changeResult(() => button('透明').click());
    samples = await pixels(samplePoints);
    assert.equal(samples[0][3], 0, 'Border-connected background becomes transparent');
    near(samples[1], redSubject);
    near(samples[2], blue);
    await screenshot('transparent-background.png');
    await changeResult(() => button('蓝色').click());
    samples = await pixels(samplePoints);
    assert.ok(samples[0][2] > samples[0][0] && samples[0][2] > samples[0][1] && samples[0][3] === 255, 'Blue preset fills background blue');
    near(samples[2], blue);
    await changeResult(() => button('红色').click());
    samples = await pixels(samplePoints);
    assert.ok(samples[0][0] > samples[0][1] && samples[0][0] > samples[0][2] && samples[0][3] === 255, 'Red preset fills background red');
    near(samples[2], blue);
    await changeResult(() => button('白色').click());

    await changeResult(() => setNativeInput(sourceColor, '#00ff00'));
    near((await pixels([[8, 8]]))[0], blue);
    await changeResult(() => button('自动取色').click());
    assert.equal((await sourceColor.inputValue()).toLowerCase(), '#2457d6');
    near((await pixels([[8, 8]]))[0], [255, 255, 255, 255]);
    await changeResult(() => setNativeInput(sourceColor, '#00ff00'));
    await button('从原图取色').click();
    const pickerPosition = await sourceImage.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const scale = Math.min(rectangle.width / element.naturalWidth, rectangle.height / element.naturalHeight);
      const imageWidth = element.naturalWidth * scale;
      const imageHeight = element.naturalHeight * scale;
      // Hit real image content even when object-fit:contain creates letterboxing.
      return { x: (rectangle.width - imageWidth) / 2 + imageWidth * 0.05, y: (rectangle.height - imageHeight) / 2 + imageHeight * 0.05 };
    });
    await changeResult(() => sourceImage.click({ position: pickerPosition }));
    assert.equal((await sourceColor.inputValue()).toLowerCase(), '#2457d6');
    near((await pixels([[8, 8]]))[0], [255, 255, 255, 255]);

    await changeResult(() => mode.selectOption({ label: '保留原背景' }));
    (await pixels(samplePoints)).forEach((pixel, index) => near(pixel, [blue, redSubject, blue][index]));
    // Filling existing transparency must not replace an opaque background.
    await mode.selectOption({ label: '填充透明区域' });
    await waitForResult();
    (await pixels(samplePoints)).forEach((pixel, index) => near(pixel, [blue, redSubject, blue][index]));
    await mode.selectOption({ label: '保留原背景' });
    await waitForResult();

    // Observe the real disabled attribute through a render; never click save.
    await saveButton.evaluate((element) => {
      window.__imagePendingSeen = element.disabled;
      window.__imagePendingObserver = new MutationObserver(() => {
        if (element.disabled) window.__imagePendingSeen = true;
      });
      window.__imagePendingObserver.observe(element, { attributes: true, attributeFilter: ['disabled'] });
    });
    await changeResult(() => widthInput.fill('60'), { width: 60, height: 40 });
    assert.equal(await heightInput.inputValue(), '40', 'Locked width preserves source aspect ratio');
    assert.equal(await page.evaluate(() => window.__imagePendingSeen), true, 'Save is disabled while a new preview is pending');
    await page.evaluate(() => window.__imagePendingObserver.disconnect());
    await changeResult(() => heightInput.fill('50'), { width: 75, height: 50 });
    assert.equal(await widthInput.inputValue(), '75', 'Locked height preserves source aspect ratio');
    await aspect.click();
    assert.equal(await aspect.getAttribute('aria-pressed'), 'false');
    await changeResult(() => widthInput.fill('90'), { width: 90, height: 50 });
    assert.equal(await heightInput.inputValue(), '50', 'Unlocked width leaves height unchanged');
    await changeResult(() => button('90°').click(), { width: 50, height: 90 });
    await changeResult(() => button('0°').click(), { width: 90, height: 50 });
    await changeResult(() => widthInput.fill('8192'), { width: 4096, height: 50 });
    assert.equal(await widthInput.inputValue(), '4096', 'Output width is bounded at 4096');
    await changeResult(() => button('恢复原始设置').click(), { width: 120, height: 80 });

    for (const [format, mime, width, height] of [
      ['JPG', 'image/jpeg', 120, 80],
      ['WebP', 'image/webp', 120, 80],
      ['ICO', 'image/png', 256, 256],
      ['PNG', 'image/png', 120, 80],
    ]) {
      // Existing UI spells the format WEBP; role lookup deliberately ignores case.
      await changeResult(() => page.getByRole('button', { name: new RegExp(`^${format}$`, 'i') }).click(), { width, height, mime });
      assert.equal(await saveButton.isEnabled(), true, `${format} is ready without calling native save`);
      if (format === 'ICO') {
        assert.equal(await widthInput.isDisabled(), true);
        assert.equal(await heightInput.isDisabled(), true);
      }
    }

    await chooseFile(transparentFile, { width: 80, height: 60, mime: 'image/png' });
    assert.equal((await pixels([[8, 8]]))[0][3], 0, 'Keep mode preserves a fully transparent source');
    await changeResult(() => mode.selectOption({ label: '填充透明区域' }));
    near((await pixels([[8, 8]]))[0], [255, 255, 255, 255]);
    await changeResult(() => button('红色').click());
    const filled = (await pixels([[8, 8], [40, 30]]));
    assert.ok(filled[0][0] > filled[0][1] && filled[0][0] > filled[0][2] && filled[0][3] === 255);
    near(filled[1], filled[0]);
    await changeResult(() => mode.selectOption({ label: '保留原背景' }));
    assert.equal((await pixels([[8, 8]]))[0][3], 0);
    await changeResult(() => button('JPG').click(), { mime: 'image/jpeg' });
    assert.equal((await pixels([[8, 8]]))[0][3], 255, 'JPG explicitly flattens unsupported alpha');
    await changeResult(() => page.getByRole('button', { name: /^webp$/i }).click(), { mime: 'image/webp' });
    assert.equal((await pixels([[8, 8]]))[0][3], 0, 'WebP preserves alpha');
    await changeResult(() => button('PNG').click(), { mime: 'image/png' });

    await chooseFile(opaqueFile, { width: 120, height: 80 });
    await mode.selectOption({ label: '替换纯色背景' });
    await button('白色').click();
    await waitForResult();
    for (const width of [1280, 1024, 760]) await assertIndependentScrolling(width, 800);
    for (const width of [1280, 1024, 760]) await assertIndependentScrolling(width, 600);

    // Exercise rejection without ever reading or creating a real user image file.
    const previousSource = await sourceImage.getAttribute('src');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'synthetic-over-20mb.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
    });
    await page.getByText(/单张原图不能超过\s*20\s*MB/).waitFor();
    assert.equal(await sourceImage.getAttribute('src'), previousSource, 'Oversized selection preserves the existing source');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'synthetic-invalid.png', mimeType: 'image/png', buffer: Buffer.from('not-a-png'),
    });
    await page.getByText(/无法解析这张图片|图片读取失败/).waitFor();
    assert.equal(await sourceImage.getAttribute('src'), previousSource, 'Decode failure preserves the existing source');
    assert.deepEqual(downloads, [], 'No browser downloads or native host save requests are exercised');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log('PASS: background modes, border-connected replacement, enclosed subject preservation, palette and manual/automatic picking, alpha, aspect locking, rotation, output limit, PNG/JPG/WebP/ICO previews, pending-save protection, independent scrolling at 1280/1024/760 x 800/600, file rejection, and no host saves.');
    console.log(`Screenshots: ${outputDirectory}`);
  } catch (error) {
    await screenshot('failure.png').catch(() => {});
    console.error(`Image UI failure URL: ${page.url()}`);
    console.error(await controls.ariaSnapshot().catch(() => 'Settings are unavailable'));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  const message = String(error.message || error).split('\nCall log:')[0];
  console.error(`${error.name || 'Error'}: ${message.slice(0, 1800)}`);
  process.exitCode = 1;
});
