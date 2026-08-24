import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../support/cockpit.ts';

// The hub composes Pi's provider catalog on the first providers request;
// that first read is the slow one.
const FIRST_READ_MS = 30_000;

type StoredAuth = Record<string, { type: string; key?: string }>;

function authPath(agentDir: string): string {
  return path.join(agentDir, 'auth.json');
}

function readAuth(agentDir: string): StoredAuth {
  return JSON.parse(fs.readFileSync(authPath(agentDir), 'utf8')) as StoredAuth;
}

test('opens the settings pages from the rail and lists providers', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('settings-open').click();
  await expect(page).toHaveURL(/\/settings\/providers$/);
  await expect(page.getByTestId('settings-section-providers')).toHaveAttribute('data-active', 'true');

  const anthropic = page.getByTestId('provider-anthropic');
  await expect(anthropic).toHaveAttribute('data-authenticated', 'false', { timeout: FIRST_READ_MS });
  await expect(page.getByTestId('provider-status-anthropic')).toHaveText(/not authenticated/);
  await expect(anthropic.getByTestId('provider-login-api_key-anthropic')).toBeVisible();
  await expect(anthropic.getByTestId('provider-login-oauth-anthropic')).toBeVisible();
  await expect(anthropic.getByTestId('provider-logout-anthropic')).toHaveCount(0);

  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('cockpit')).toBeVisible();
  await expect(page).toHaveURL(/\/session\/s1$/);
});

test('shows a provider as authenticated from auth.json and signs it out', async ({ page, cockpit }) => {
  fs.writeFileSync(authPath(cockpit.agentDir), JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-test' } }));

  await page.goto(`${cockpit.url}/settings/providers`);
  const anthropic = page.getByTestId('provider-anthropic');
  await expect(anthropic).toHaveAttribute('data-authenticated', 'true', { timeout: FIRST_READ_MS });
  await expect(page.getByTestId('provider-status-anthropic')).toHaveText(/authenticated · api key · stored/);

  await page.getByTestId('provider-logout-anthropic').click();
  await expect(anthropic).toHaveAttribute('data-authenticated', 'false');
  await expect(page.getByTestId('provider-status-anthropic')).toHaveText(/not authenticated/);
  expect(readAuth(cockpit.agentDir).anthropic).toBeUndefined();
});

test('signs in with an API key through the login flow', async ({ page, cockpit }) => {
  await page.goto(`${cockpit.url}/settings/providers`);
  await page.getByTestId('provider-login-api_key-anthropic').click({ timeout: FIRST_READ_MS });

  const dialog = page.getByTestId('login-flow');
  await expect(dialog).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('login-prompt')).toHaveAttribute('data-prompt-type', 'secret');
  await expect(page.getByTestId('login-prompt')).toContainText(/api key/i);
  await page.getByTestId('login-prompt-input').fill('sk-ant-e2e');
  await page.getByTestId('login-prompt-submit').click();

  await expect(dialog).toHaveAttribute('data-status', 'succeeded');
  await expect(page.getByTestId('login-flow-result')).toHaveText(/authenticated with Anthropic/);
  await page.getByTestId('login-flow-close').click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByTestId('provider-anthropic')).toHaveAttribute('data-authenticated', 'true');
  await expect(page.getByTestId('provider-status-anthropic')).toHaveText(/authenticated · api key · stored/);
  expect(readAuth(cockpit.agentDir).anthropic).toEqual({ type: 'api_key', key: 'sk-ant-e2e' });
});

test('cancels a login flow and stays signed out', async ({ page, cockpit }) => {
  await page.goto(`${cockpit.url}/settings/providers`);
  await page.getByTestId('provider-login-api_key-anthropic').click({ timeout: FIRST_READ_MS });

  const dialog = page.getByTestId('login-flow');
  await expect(page.getByTestId('login-prompt-input')).toBeVisible();
  await page.getByTestId('login-flow-cancel').click();
  await expect(dialog).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('login-flow-result')).toHaveText(/cancelled/);
  await page.getByTestId('login-flow-close').click();

  await expect(page.getByTestId('provider-anthropic')).toHaveAttribute('data-authenticated', 'false');
  expect(fs.existsSync(authPath(cockpit.agentDir)) ? readAuth(cockpit.agentDir).anthropic : undefined).toBeUndefined();
});
