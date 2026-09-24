import { expect, test } from '@playwright/test';
import { build } from 'tsdown';

import { activityAppHtml } from '../../generated/mcp-apps/activity';
import type {} from './host';

let hostScript: string;
test.beforeAll(async () => {
  const built = await build({
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
  const chunk = built.bundles[0]?.chunks[0];
  if (chunk?.type !== 'chunk') throw new Error('Missing browser host harness');
  hostScript = chunk.code;
  for (const bundle of built.bundles) await bundle[Symbol.asyncDispose]();
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><title>Tool activity host</title>');
  await page.addScriptTag({ content: hostScript });
});

for (const name of ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'task', 'mcp_use', 'future_tool']) {
  test(`shows ${name} inputs and results without calling tools`, async ({ page }) => {
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('http')) requests.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluate(({ html, tool }) => window.startSessionHost(html, true, tool), {
      html: activityAppHtml,
      tool: name,
    });
    const frame = page.frameLocator('#session-app');
    await expect(frame.getByRole('heading')).toHaveText(name);
    await expect(frame.getByRole('status')).toHaveText('Running tool...');
    await page.evaluate(() =>
      window.sessionHost.input({ path: 'src/widget.ts', content: 'private contents', command: 'SECRET=token run' }),
    );
    await expect(frame.locator('#input')).toContainText('src/widget.ts');
    await expect(frame.locator('#input')).not.toContainText('private contents');
    await expect(frame.locator('#input')).not.toContainText('SECRET');
    await page.evaluate(
      (tool) =>
        window.sessionHost.send({
          content: [{ type: 'text', text: 'Tool output for the user' }],
          _meta: { 'doompi/toolActivity': { tool, title: tool, input: { path: 'src/widget.ts' }, durationMs: 1250 } },
        }),
      name,
    );
    await expect(frame.getByRole('status')).toHaveText('Result received');
    await expect(frame.locator('#preview')).toHaveText('Tool output for the user');
    await expect(frame.locator('#duration')).toHaveText('1.3 s');
    expect(await page.evaluate(() => window.sessionHost.calls)).toEqual([]);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('renders streamed input and bounded untrusted output across themes and narrow widths', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) requests.push(request.url());
  });
  await page.evaluate((html) => window.startSessionHost(html, false, 'grep'), activityAppHtml);
  const frame = page.frameLocator('#session-app');
  await page.evaluate(() => window.sessionHost.input({ pattern: 'resourceUri' }, true));
  await expect(frame.getByRole('status')).toHaveText('Preparing tool...');
  await page.evaluate(() => window.sessionHost.input({ path: 'packages/core', pattern: 'resourceUri', limit: 100 }));
  await expect(frame.getByRole('status')).toHaveText('Running tool...');
  await page.screenshot({ path: testInfo.outputPath('activity-running.png') });
  const text = '<img src=https://example.invalid/track onerror=alert(1)>\n' + 'long output '.repeat(1500);
  await page.evaluate((value) => window.sessionHost.send({ content: [{ type: 'text', text: value }] }), text);
  await expect(frame.locator('#preview')).toContainText('<img src=');
  await expect(frame.locator('img')).toHaveCount(0);
  expect((await frame.locator('#preview').textContent())?.length).toBe(8000);
  await expect(frame.locator('#note')).toContainText('Preview truncated');
  await expect
    .poll(() =>
      frame.locator('main').evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight + 1),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('activity-light.png') });
  await page.evaluate(() => window.sessionHost.theme('dark'));
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('activity-dark.png') });
  await page.setViewportSize({ width: 320, height: 640 });
  const width = await frame
    .locator('html')
    .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.width);
  await expect
    .poll(() =>
      frame.locator('main').evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight + 1),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('activity-narrow.png') });
  await frame.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(frame.locator('#preview')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(frame.locator('#preview')).toBeVisible();
  expect(requests).toEqual([]);
});

test('renders failed calls without turning the output into an action', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, true, 'write'), activityAppHtml);
  await page.evaluate(() =>
    window.sessionHost.send({
      content: [{ type: 'text', text: 'Permission denied: src/widget.ts' }],
      isError: true,
      _meta: { 'doompi/toolActivity': { title: 'Write file', input: { path: 'src/widget.ts' }, durationMs: 50 } },
    }),
  );
  const frame = page.frameLocator('#session-app');
  await expect(frame.getByRole('heading')).toHaveText('Write file');
  await expect(frame.getByRole('status')).toHaveText('Tool failed');
  await expect(frame.locator('#preview')).toContainText('Permission denied');
  await expect(frame.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionHost.calls)).toEqual([]);
});

test('renders structured-only output and ignores malformed activity metadata', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, false, 'task'), activityAppHtml);
  await page.evaluate(() =>
    window.sessionHost.send({
      content: [],
      structuredContent: { tasks: [{ status: 'in_progress' }] },
      _meta: {
        'doompi/toolActivity': { title: 123, tool: 'task', durationMs: 'bad', input: { path: { secret: true } } },
      },
    }),
  );
  const frame = page.frameLocator('#session-app');
  await expect(frame.getByRole('heading')).toHaveText('task');
  await expect(frame.getByRole('status')).toHaveText('Result received');
  await expect(frame.locator('#preview')).toContainText('in_progress');
  await expect(frame.locator('#duration')).toBeEmpty();
  await expect(frame.locator('#input')).toBeHidden();
});

test('reports non-text results without fetching embedded resources', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, false, 'read'), activityAppHtml);
  await page.evaluate(() =>
    window.sessionHost.send({ content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }),
  );
  const frame = page.frameLocator('#session-app');
  await expect(frame.locator('#preview')).toHaveText('Non-text result returned to the agent.');
  await expect(frame.locator('#note')).toContainText('1 non-text');
  await expect(frame.locator('img')).toHaveCount(0);
});

test('handles an empty result without requiring widget metadata', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, false, 'ls'), activityAppHtml);
  await page.evaluate(() => window.sessionHost.send({ content: [] }));
  const frame = page.frameLocator('#session-app');
  await expect(frame.getByRole('status')).toHaveText('Result received');
  await expect(frame.locator('#preview')).toHaveText('No text output.');
});

test('cancellation and teardown ignore late data and never replay a tool', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, true, 'bash'), activityAppHtml);
  const frame = page.frameLocator('#session-app');
  await page.evaluate(() => window.sessionHost.cancel());
  await expect(frame.getByRole('status')).toHaveText('Tool cancelled');
  await page.evaluate(() => window.sessionHost.input({ path: 'late' }));
  await page.evaluate(() => window.sessionHost.send({ content: [{ type: 'text', text: 'late result' }] }));
  await expect(frame.getByRole('status')).toHaveText('Tool cancelled');
  await expect(frame.locator('#output')).toBeHidden();
  await page.evaluate(() => window.sessionHost.teardown());
  await expect(frame.getByRole('status')).toHaveText('Activity view closed.');
  expect(await page.evaluate(() => window.sessionHost.calls)).toEqual([]);
});

test('does not mistake returned background work for completion of that work', async ({ page }) => {
  await page.evaluate((html) => window.startSessionHost(html, false, 'bash'), activityAppHtml);
  await page.evaluate(() =>
    window.sessionHost.send({ content: [{ type: 'text', text: 'Runner build-1 is still running.' }] }),
  );
  const frame = page.frameLocator('#session-app');
  await expect(frame.getByRole('status')).toHaveText('Result received');
  await expect(frame.locator('#preview')).toContainText('still running');
  await page.evaluate(() => window.sessionHost.cancel());
  await expect(frame.getByRole('status')).toHaveText('Result received');
});
