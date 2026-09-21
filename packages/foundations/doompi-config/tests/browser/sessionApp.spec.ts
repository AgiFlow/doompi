import { expect, test } from '@playwright/test';
import { build } from 'tsdown';

import { sessionAppHtml } from '../../generated/mcp-apps/session';
import type { SessionView } from '../../src/types/sessionView';
import type {} from './host';

const view: SessionView = {
  sessionId: 'session-a',
  revision: 1,
  repositoryName: 'doompi',
  profile: 'ponytail',
  majorMode: 'copilot',
  domains: ['development', 'testing'],
  layers: ['team'],
  minorModes: [],
};
const result = (data: SessionView = view) => ({
  content: [{ type: 'text' as const, text: 'Session summary' }],
  structuredContent: { ...data },
});
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

test('renders delayed results, refreshes through the bridge, and changes theme without network access', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) requests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><title>Session app host</title>');
  await page.addScriptTag({ content: hostScript });
  await page.evaluate((html) => window.startSessionHost(html, true), sessionAppHtml);
  const frame = page.frameLocator('#session-app');
  await expect(frame.getByRole('status')).toHaveText('Waiting for session data...');
  await expect(frame.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  await page.evaluate((data) => window.sessionHost.send(data), result());
  await expect(frame.locator('#repositoryName')).toHaveText('doompi');
  await expect(frame.locator('#sessionId')).toHaveText('session-a');
  await page.screenshot({ path: testInfo.outputPath('session-light.png') });
  await page.evaluate((data) => window.sessionHost.respond(data), result({ ...view, revision: 2 }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.locator('#revision')).toHaveText('2');
  expect(await page.evaluate(() => window.sessionHost.calls)).toEqual([{ name: 'show_session', arguments: {} }]);
  await page.evaluate(() => window.sessionHost.theme('dark'));
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('session-dark.png') });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(frame.locator('#summary')).toBeVisible();
  const width = await frame
    .locator('html')
    .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.width);
  await page.screenshot({ path: testInfo.outputPath('session-narrow.png') });
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('does not render untrusted HTML and hides stale data after failed refresh', async ({ page }) => {
  await page.setContent('<!doctype html><title>Session app host</title>');
  await page.addScriptTag({ content: hostScript });
  await page.evaluate((html) => window.startSessionHost(html, true), sessionAppHtml);
  const frame = page.frameLocator('#session-app');
  const label = '<img src=x onerror=alert(1)>';
  await page.evaluate((data) => window.sessionHost.send(data), result({ ...view, repositoryName: label }));
  await expect(frame.locator('#repositoryName')).toHaveText(label);
  await expect(frame.locator('img')).toHaveCount(0);
  await page.evaluate(() => window.sessionHost.respond({ content: [], isError: true }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.getByRole('status')).toContainText('could not be loaded');
  await expect(frame.locator('#summary')).toBeHidden();
  await page.evaluate((data) => window.sessionHost.respond(data), result());
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.locator('#summary')).toBeVisible();
  await page.evaluate(() => window.sessionHost.teardown());
  await expect(frame.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  await expect(frame.getByRole('status')).toHaveText('Session view closed.');
});

test('rejects malformed results and a refresh routed to another session', async ({ page }) => {
  await page.setContent('<!doctype html><title>Session app host</title>');
  await page.addScriptTag({ content: hostScript });
  await page.evaluate((html) => window.startSessionHost(html, true), sessionAppHtml);
  const frame = page.frameLocator('#session-app');
  await page.evaluate(() => window.sessionHost.send({ content: [], structuredContent: { sessionId: 123 } }));
  await expect(frame.getByRole('status')).toContainText('invalid session summary');
  await page.evaluate((data) => window.sessionHost.send(data), result());
  await page.evaluate((data) => window.sessionHost.respond(data), result({ ...view, sessionId: 'session-b' }));
  await frame.getByRole('button', { name: 'Refresh' }).click();
  await expect(frame.getByRole('status')).toContainText('The session changed');
  await expect(frame.locator('#summary')).toBeHidden();
});

test('renders without requiring component tool-call support', async ({ page }) => {
  await page.setContent('<!doctype html><title>Session app host</title>');
  await page.addScriptTag({ content: hostScript });
  await page.evaluate((html) => window.startSessionHost(html, false), sessionAppHtml);
  await page.evaluate((data) => window.sessionHost.send(data), result());
  const frame = page.frameLocator('#session-app');
  await expect(frame.locator('#repositoryName')).toHaveText('doompi');
  await expect(frame.getByRole('button', { name: 'Refresh' })).toBeDisabled();
});
