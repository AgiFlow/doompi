import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { build } from 'tsdown';

import { bundleMcpApp, type McpAppSource } from '../../src/builders/server/mcpApp';
import type {} from './host';

const repository = path.resolve(import.meta.dirname, '../../../../..');
const sources: McpAppSource[] = [];
for (const directory of ['packages', 'layers']) {
  for (const category of fs
    .readdirSync(path.join(repository, directory), { withFileTypes: true })
    .filter((item) => item.isDirectory())) {
    for (const name of fs
      .readdirSync(path.join(repository, directory, category.name), { withFileTypes: true })
      .filter((item) => item.isDirectory())) {
      const root = path.join(repository, directory, category.name, name.name);
      if (!fs.existsSync(path.join(root, 'package.json'))) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (manifest.doompiMcp?.ui)
        sources.push({ file: path.resolve(root, manifest.doompiMcp.ui.dist), widgets: manifest.doompiMcp.ui.widgets });
    }
  }
}
const keys = sources.flatMap((source) => source.widgets);
const view = {
  sessionId: 'session-a',
  revision: 1,
  repositoryName: 'doompi',
  profile: 'ponytail',
  majorMode: 'copilot',
  domains: ['development'],
  layers: ['team'],
  minorModes: [],
};
const sessionResult = (data = view) => ({
  content: [{ type: 'text' as const, text: 'Session summary' }],
  structuredContent: data,
});
let html: string;
let hostScript: string;
let temporary: string;

test.beforeAll(async () => {
  expect(keys.length).toBeGreaterThanOrEqual(21);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-widget-browser-'));
  const bundle = await bundleMcpApp(sources, temporary);
  expect(bundle).toBeDefined();
  html = fs.readFileSync(path.join(temporary, bundle!.file), 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=/u);
  expect(html).not.toContain('process.env.NODE_ENV');
  expect(html).not.toContain('/Users/');
  expect(html).not.toContain('/home/runner/');
  const host = await build({
    config: false,
    entry: 'tests/browser/host.ts',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    dts: false,
    write: false,
    clean: false,
    logLevel: 'silent',
    deps: { alwaysBundle: [/./], onlyBundle: ['@modelcontextprotocol/ext-apps', '@modelcontextprotocol/sdk', 'zod'] },
  });
  const chunk = host.bundles[0]?.chunks[0];
  if (chunk?.type !== 'chunk') throw new Error('Missing MCP host harness');
  hostScript = chunk.code;
  for (const bundle of host.bundles) await bundle[Symbol.asyncDispose]();
});
test.afterAll(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  await page.setContent('<!doctype html><title>MCP widget host</title>');
  await page.addScriptTag({ content: hostScript });
});

for (const key of keys) {
  test(`renders package-owned widget ${key}`, async ({ page }, testInfo) => {
    const name = key.endsWith('/session_mcp') ? 'mcp__fixture__search' : key.split('/').at(-1)!;
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('http')) requests.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluate(({ html, name, key }) => window.startWidgetHost(html, name, key), { html, name, key });
    const frame = page.frameLocator('#tool-widget');
    await expect(frame.getByRole('heading')).toBeVisible();
    await page.evaluate(() =>
      window.widgetHost.input({
        path: 'src/example.ts',
        pattern: 'needle',
        name: 'sample',
        action: 'list',
        server: 'fixture',
        tool: 'search',
      }),
    );
    await expect(frame.getByRole('status')).toHaveText('Running tool...');
    if (name === 'show_session') {
      await page.evaluate((result) => window.widgetHost.send(result), sessionResult());
      await expect(frame.getByText('session-a', { exact: true })).toBeVisible();
    } else {
      await page.evaluate(() => window.widgetHost.send({ content: [{ type: 'text', text: 'Package tool output' }] }));
      await expect(frame.getByLabel('Tool output preview')).toHaveText('Package tool output');
    }
    await expect(frame.getByRole('status')).toHaveText('Result received');
    await page.screenshot({ path: testInfo.outputPath('widget.png') });
    expect(await page.evaluate(() => window.widgetHost.calls)).toEqual([]);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('handles streamed input, untrusted bounded text, themes, narrow layouts, and keyboard expansion', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) requests.push(request.url());
  });
  await page.evaluate((html) => window.startWidgetHost(html, 'grep', '@agimon-ai/doompi-grep/grep'), html);
  const frame = page.frameLocator('#tool-widget');
  await page.evaluate(() => window.widgetHost.input({ pattern: 'resource' }, true));
  await expect(frame.getByRole('status')).toHaveText('Preparing tool...');
  await page.evaluate(() => window.widgetHost.input({ pattern: 'resourceUri', path: 'packages/core' }));
  await expect(frame.getByText('resourceUri', { exact: true })).toBeVisible();
  const text = '<img src=https://example.invalid/track onerror=alert(1)>\n' + 'long output '.repeat(1500);
  await page.evaluate((text) => window.widgetHost.send({ content: [{ type: 'text', text }] }), text);
  await expect(frame.locator('img')).toHaveCount(0);
  expect((await frame.getByLabel('Tool output preview').textContent())?.length).toBe(8000);
  await expect(frame.getByText('Preview truncated.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('light.png') });
  await page.evaluate(() => window.widgetHost.theme('dark'));
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('dark.png') });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(async () => frame.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow.png') });
  await frame.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(frame.getByLabel('Tool output preview')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(frame.getByLabel('Tool output preview')).toBeVisible();
  expect(requests).toEqual([]);
});

test('routes a delayed result without host toolInfo using approved invocation metadata', async ({ page }) => {
  await page.evaluate((html) => window.startWidgetHost(html), html);
  const frame = page.frameLocator('#tool-widget');
  await expect(frame.getByRole('status')).toHaveText('Waiting for tool information...');
  await page.evaluate(() =>
    window.widgetHost.send({
      content: [{ type: 'text', text: 'found' }],
      _meta: { 'doompi/toolName': 'find', 'doompi/widget': '@agimon-ai/doompi-ui/find' },
    }),
  );
  await expect(frame.getByRole('heading')).toHaveText('Find files');
  await expect(frame.getByLabel('Tool output preview')).toHaveText('found');
});

test('never falls back to an unrelated renderer or switches invocation identity', async ({ page }) => {
  await page.evaluate((html) => window.startWidgetHost(html, 'read', '@agimon-ai/doompi-read/read'), html);
  await page.evaluate(() =>
    window.widgetHost.send({
      content: [{ type: 'text', text: 'wrong tool output' }],
      _meta: { 'doompi/toolName': 'write', 'doompi/widget': '@agimon-ai/doompi-ui/write' },
    }),
  );
  const frame = page.frameLocator('#tool-widget');
  await expect(frame.getByRole('status')).toContainText('The tool changed');
  await expect(frame.getByRole('heading')).toHaveCount(0);
});

test('unknown widget keys show an explicit unavailable state', async ({ page }) => {
  await page.evaluate((html) => window.startWidgetHost(html, 'unknown', '@test/unknown'), html);
  await expect(page.frameLocator('#tool-widget').getByRole('status')).toHaveText(
    'No widget is available for this tool.',
  );
});

test('shows errors and structured-only or non-text output without fetching resources or replaying calls', async ({
  page,
}) => {
  await page.evaluate((html) => window.startWidgetHost(html, 'write', '@agimon-ai/doompi-ui/write'), html);
  await page.evaluate(() => window.widgetHost.input({ path: 'src/test.ts', content: 'PRIVATE_CONTENT' }));
  const frame = page.frameLocator('#tool-widget');
  await expect(frame.getByText('PRIVATE_CONTENT')).toHaveCount(0);
  await page.evaluate(() =>
    window.widgetHost.send({
      content: [{ type: 'image', data: btoa('non-rendered image fixture'), mimeType: 'image/png' }],
      structuredContent: { message: 'Permission denied' },
      isError: true,
    }),
  );
  await expect(frame.getByRole('status')).toHaveText('Tool failed');
  await expect(frame.getByLabel('Tool output preview')).toContainText('Permission denied');
  await expect(frame.locator('img')).toHaveCount(0);
  await expect(frame.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => window.widgetHost.calls)).toEqual([]);
});

test('cancels once, ignores late data, and tears down the bridge', async ({ page }) => {
  await page.evaluate((html) => window.startWidgetHost(html, 'bash', '@agimon-ai/doompi-runner/bash'), html);
  const frame = page.frameLocator('#tool-widget');
  await page.evaluate(() => window.widgetHost.cancel());
  await expect(frame.getByRole('status')).toHaveText('Tool cancelled');
  await page.evaluate(() => window.widgetHost.send({ content: [{ type: 'text', text: 'late result' }] }));
  await page.evaluate(() => window.widgetHost.input({ command: 'late input' }));
  await expect(frame.getByRole('status')).toHaveText('Tool cancelled');
  await expect(frame.getByLabel('Tool output preview')).toHaveCount(0);
  await page.evaluate(() => window.widgetHost.teardown());
  await expect(frame.getByRole('status')).toHaveText('Tool view closed.');
});

test('does not label background work as completed', async ({ page }) => {
  await page.evaluate((html) => window.startWidgetHost(html, 'bash', '@agimon-ai/doompi-runner/bash'), html);
  await page.evaluate(() =>
    window.widgetHost.send({ content: [{ type: 'text', text: 'Runner build-1 is still running.' }] }),
  );
  await expect(page.frameLocator('#tool-widget').getByRole('status')).toHaveText('Result received');
});

test('refreshes session through its package widget, hides failures, and rejects another session', async ({ page }) => {
  await page.evaluate(
    (html) => window.startWidgetHost(html, 'show_session', '@agimon-ai/doompi-config/show_session', true),
    html,
  );
  const frame = page.frameLocator('#tool-widget');
  await expect(frame.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  await page.evaluate((data) => window.widgetHost.send(data), sessionResult());
  await page.evaluate((data) => window.widgetHost.respond(data), sessionResult({ ...view, revision: 2 }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.getByText('2', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.widgetHost.calls)).toEqual([{ name: 'show_session', arguments: {} }]);
  await page.evaluate(() => window.widgetHost.respond({ content: [], isError: true }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.getByRole('status')).toContainText('could not be loaded');
  await expect(frame.getByText('session-a', { exact: true })).toHaveCount(0);
  await page.evaluate((data) => window.widgetHost.respond(data), sessionResult({ ...view, sessionId: 'session-b' }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.getByRole('status')).toContainText('session changed');
  await expect(frame.getByText('session-b', { exact: true })).toHaveCount(0);
});

test('validates malformed session output and disables refresh without host tool support', async ({ page }) => {
  await page.evaluate(
    (html) => window.startWidgetHost(html, 'show_session', '@agimon-ai/doompi-config/show_session', true, false),
    html,
  );
  await page.evaluate(() => window.widgetHost.send({ content: [], structuredContent: { sessionId: 123 } }));
  const frame = page.frameLocator('#tool-widget');
  await expect(frame.getByRole('status')).toContainText('invalid session summary');
  await expect(frame.getByRole('button', { name: 'Refresh' })).toBeDisabled();
});
