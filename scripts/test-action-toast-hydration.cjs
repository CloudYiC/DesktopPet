/** Shared ActionToast SSR/hydration regression. Real component source, in-memory
 * bundles and an isolated browser; no app server, network, devices or new deps. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const frontendRequire = createRequire(path.join(root, 'frontend/package.json'));
const { build } = frontendRequire('esbuild');

// The exact same tree must render on the server and during initial hydration.
function createFixture(React, { ActionToast, useActionToast }) {
  return function Fixture() {
    const { toast, notify, dismiss } = useActionToast();
    return React.createElement('main', null,
      React.createElement('h1', null, 'Hydration fixture'),
      React.createElement('button', { onClick: () => notify('Mounted notification') }, 'Notify'),
      React.createElement(ActionToast, { toast, onDismiss: dismiss }),
      React.createElement('p', null, 'Server-rendered content stays intact'));
  };
}

async function bundle(platform, contents) {
  const result = await build({
    stdin: { contents, resolveDir: root, sourcefile: `action-toast-${platform}-fixture.js` },
    absWorkingDir: root, bundle: true, write: false, platform,
    format: platform === 'node' ? 'cjs' : 'iife', jsx: 'automatic',
    nodePaths: [path.join(root, 'frontend/node_modules')],
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'ignore-css-modules', setup(builder) {
      builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
    } }],
  });
  return result.outputFiles[0].text;
}

(async () => {
  const shared = `import * as React from 'react';
    import { ActionToast, useActionToast } from './shared/tool-workspace/ActionToast.tsx';
    const createFixture = ${createFixture.toString()};
    const Fixture = createFixture(React, { ActionToast, useActionToast });`;
  const [serverCode, clientCode] = await Promise.all([
    bundle('node', `${shared}
      import { renderToString } from 'react-dom/server';
      export const html = renderToString(React.createElement(Fixture));
      export const prefilledHtml = renderToString(React.createElement(ActionToast,
        { toast: { id: 1, message: 'Never create a server portal' }, onDismiss() {} }));`),
    bundle('browser', `${shared}
      import { hydrateRoot } from 'react-dom/client';
      window.__hydrationErrors = [];
      hydrateRoot(document.getElementById('root'), React.createElement(Fixture),
        { onRecoverableError(error) { window.__hydrationErrors.push(error.message); } });`),
  ]);
  const serverModule = { exports: {} };
  new Function('module', 'exports', 'require', serverCode)(serverModule, serverModule.exports, require);
  const { html, prefilledHtml } = serverModule.exports;
  assert.equal(prefilledHtml, '', 'SSR never creates a portal, even with a prefilled toast');
  assert.doesNotMatch(html, /action-toast|Mounted notification/, 'Initial server tree contains no toast');

  const browser = await chromium.launch({ headless: true, executablePath: process.env.PACKET_TEST_BROWSER || undefined });
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  const consoleErrors = [], pageErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.setContent(`<div id="root">${html}</div>`);
    await page.evaluate(() => { window.__serverMain = document.querySelector('#root > main'); });
    await page.addScriptTag({ content: clientCode });
    await page.getByRole('button', { name: 'Notify', exact: true }).click();
    const toast = page.getByTestId('action-toast');
    await toast.waitFor();
    assert.match(await toast.innerText(), /Mounted notification/, 'Notify works after mounting');
    assert.equal(await page.evaluate(() => document.querySelector('#root > main') === window.__serverMain), true,
      'Hydration preserves the original server DOM instead of replacing the root');
    assert.equal(await toast.evaluate((element) => element.parentElement.parentElement === document.body), true,
      'Mounted toast uses a body portal outside the workspace');
    await toast.getByRole('button', { name: '关闭操作提示' }).click();
    await toast.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.__hydrationErrors), [], 'No recoverable hydration errors');
    assert.deepEqual(consoleErrors, [], 'No React hydration warnings');
    assert.deepEqual(pageErrors, [], 'No browser runtime errors');
    console.log('PASS ActionToast hydration: actual shared source, portal-free SSR, preserved server DOM, no hydration errors, mounted notify and dismiss.');
  } finally { await context.close(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
