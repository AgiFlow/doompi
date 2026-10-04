import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { build } from 'tsdown';

declare global {
  interface Window {
    createInlineSandbox(html: string, protocol?: 'mcp' | 'openai'): Promise<void>;
    inlineEvents: Array<{ type: string; data?: unknown }>;
    inlinePort: MessagePort;
  }
}

let temporary: string;
let hostScript: string;

test.beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-inline-sandbox-'));
  const frontend = path.resolve('../../default/doompi-mcp/src/extensions/workspaces/sessions/(frontend)/tool/_lib');
  const entry = path.join(temporary, 'host.ts');
  // Compile the real browser modules, including their serialized bootstrap functions.
  fs.writeFileSync(
    entry,
    `
    import { mcpAppCsp, mcpAppDocument, mcpAppRelayHtml, supportsMcpAppSandbox } from ${JSON.stringify(path.join(frontend, 'mcpAppSandbox.ts'))};
    import { mcpOpenAiScript } from ${JSON.stringify(path.join(frontend, 'mcpOpenAiBootstrap.ts'))};
    window.createInlineSandbox = async (html, protocol = 'mcp') => {
      if (!supportsMcpAppSandbox()) throw new Error('Browser lacks required CSP enforcement');
      const policy = mcpAppCsp({}, location.origin);
      const relay = document.createElement('iframe');
      relay.id = 'relay';
      relay.setAttribute('sandbox', 'allow-scripts');
      relay.srcdoc = mcpAppRelayHtml(policy);
      const channel = new MessageChannel();
      window.inlinePort = channel.port1;
      window.inlineEvents = [];
      channel.port1.onmessage = ({ data }) => {
        window.inlineEvents.push(data);
        if (data.type === 'legacy' && data.data.id !== undefined) {
          channel.port1.postMessage({ channel: 'doompi.openai', id: data.data.id, result: { acknowledged: true } });
        }
      };
      window.addEventListener('message', (event) => {
        if (event.source === relay.contentWindow) window.inlineEvents.push({ type: 'mcp', data: event.data });
      });
      const bootstrap = protocol === 'openai' ? mcpOpenAiScript({
        toolInput: { query: 'sample' }, toolOutput: false,
        toolResponseMetadata: { private: '</script>sentinel' }, widgetState: { page: 1 },
        theme: 'dark', locale: 'en', displayMode: 'inline', maxHeight: 1200,
        userAgent: { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } },
        safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } },
      }) : '';
      await new Promise((resolve) => {
        relay.addEventListener('load', () => {
          relay.contentWindow.postMessage({ html: mcpAppDocument(html, policy, bootstrap), policy, protocol }, '*', [channel.port2]);
          resolve();
        }, { once: true });
        document.body.append(relay);
      });
    };
  `,
  );
  const output = await build({
    config: false,
    entry,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    dts: false,
    write: false,
    clean: false,
    logLevel: 'silent',
  });
  const chunk = output.bundles[0]?.chunks[0];
  if (chunk?.type !== 'chunk') throw new Error('Missing inline sandbox harness');
  hostScript = chunk.code;
  for (const bundle of output.bundles) await bundle[Symbol.asyncDispose]();
});

test.afterAll(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route('https://cockpit.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Inline sandbox test</title>',
    }),
  );
  await page.goto('https://cockpit.test/');
  await page.addScriptTag({ content: hostScript });
});

test('isolates parent DOM and storage and blocks undeclared requests, forms, and popups', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/*', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.evaluate(() =>
    window.createInlineSandbox(`
    <button id="attempt">Attempt escape</button><output></output>
    <script>
      document.querySelector('button').onclick = async () => {
        const denied = [];
        for (const [name, action] of [
          ['dom', () => top.document.body], ['storage', () => localStorage.getItem('token')],
          ['cookie', () => document.cookie], ['top-navigation', () => { top.location.href = 'https://attacker.test/top'; }],
        ]) { try { action(); } catch { denied.push(name); } }
        if (window.open('https://attacker.test/popup') === null) denied.push('popup');
        await new Promise((resolve) => {
          const worker = new Worker('data:text/javascript,postMessage(1)');
          worker.onerror = () => { denied.push('worker'); resolve(); };
          worker.onmessage = () => { worker.terminate(); resolve(); };
        });
        await fetch('https://cockpit.test/private').catch(() => denied.push('fetch'));
        const image = new Image(); image.src = 'https://attacker.test/image'; document.body.append(image);
        const form = document.createElement('form'); form.action = 'https://attacker.test/form';
        document.body.append(form); form.submit();
        document.querySelector('output').textContent = denied.sort().join(',');
      };
    </script>
  `),
  );
  const frame = page.frameLocator('#relay').frameLocator('iframe');
  await frame.getByRole('button', { name: 'Attempt escape' }).click();
  await expect(frame.locator('output')).toHaveText('cookie,dom,fetch,popup,storage,top-navigation,worker');
  expect(requests).toEqual([]);
  expect(page.url()).toBe('https://cockpit.test/');
});

for (const timing of ['early', 'late']) {
  test(`blocks ${timing} self-navigation before a network request`, async ({ page }) => {
    const requests: string[] = [];
    const violations: string[] = [];
    page.on('console', (message) => violations.push(message.text()));
    await page.route('**/*', (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.evaluate(
      (timing) =>
        window.createInlineSandbox(
          timing === 'early'
            ? `<script>location.href = 'https://attacker.test/early'</script>`
            : `<button onclick="location.href = 'https://attacker.test/late'">Navigate</button>`,
        ),
      timing,
    );
    if (timing === 'late')
      await page.frameLocator('#relay').frameLocator('iframe').getByRole('button', { name: 'Navigate' }).click();
    await expect
      .poll(() => violations.some((message) => message.includes('frame-src about:') && message.includes('blocked')))
      .toBe(true);
    expect(requests).toEqual([]);
    expect(page.url()).toBe('https://cockpit.test/');
  });
}

for (const [name, action] of [
  ['oversized message', `parent.postMessage('x'.repeat(65537), '*')`],
  ['message flood', `for (let i = 0; i < 129; i++) parent.postMessage({ jsonrpc: '2.0' }, '*')`],
  ['second document', `location.href = 'about:blank'`],
]) {
  test(`revokes the real frame after ${name}`, async ({ page }) => {
    await page.evaluate((action) => window.createInlineSandbox(`<button onclick="${action}">Revoke</button>`), action);
    await page.frameLocator('#relay').frameLocator('iframe').getByRole('button', { name: 'Revoke' }).click();
    await expect
      .poll(() => page.evaluate(() => window.inlineEvents.some((event) => event.type === 'revoked')))
      .toBe(true);
    await expect(page.frameLocator('#relay').locator('iframe')).toHaveCount(0);
  });
}

test('makes legacy globals available to the first script and carries state and callbacks over the private port', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.createInlineSandbox(
      `
    <output id="initial"></output><output id="result"></output><output id="theme"></output>
    <button>Save state</button>
    <script>
      const api = window.openai;
      document.querySelector('#initial').textContent = JSON.stringify([api.toolOutput, api.toolResponseMetadata.private, api.widgetState]);
      window.addEventListener('openai:set_globals', () => { document.querySelector('#theme').textContent = api.theme; });
      document.querySelector('button').onclick = async () => {
        const saved = api.setWidgetState({ page: 2 });
        const immediate = api.widgetState.page;
        await saved;
        const response = await api.callTool('app_data', { page: 2 });
        const display = await api.requestDisplayMode({ mode: 'fullscreen' });
        document.querySelector('#result').textContent = JSON.stringify([immediate, response.acknowledged, display.mode]);
      };
    </script>
  `,
      'openai',
    ),
  );
  const frame = page.frameLocator('#relay').frameLocator('iframe');
  await expect(frame.locator('#initial')).toHaveText('[false,"</script>sentinel",{"page":1}]');
  await frame.getByRole('button', { name: 'Save state' }).click();
  await expect(frame.locator('#result')).toHaveText('[2,true,"inline"]');
  await page.evaluate(() => window.inlinePort.postMessage({ channel: 'doompi.openai', globals: { theme: 'light' } }));
  await expect(frame.locator('#theme')).toHaveText('light');
  expect(
    await page.evaluate(() =>
      window.inlineEvents.filter((event) => event.type === 'legacy').map((event) => event.data),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'setState', input: { state: { page: 2 } } }),
      expect.objectContaining({ method: 'callTool', input: { name: 'app_data', arguments: { page: 2 } } }),
    ]),
  );
});
