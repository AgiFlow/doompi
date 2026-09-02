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

test('saves a named tunnel on the remote control settings page and reuses it after reload', async ({
  page,
  cockpit,
}) => {
  let tunnel: Record<string, unknown> = { kind: 'quick' };
  const settings = () => ({
    autoCloseEnabled: false,
    autoCloseMinutes: 60,
    sessionExpiryEnabled: false,
    idleMinutes: 30,
    absoluteHours: 12,
    tunnel,
    sandbox: { enabled: false, workspaces: [] },
  });
  await page.route('**/api/remote', async (route) => {
    await route.fulfill({ json: { state: { status: 'off', devices: [], pending: [], settings: settings() } } });
  });
  await page.route('**/api/remote/settings', async (route) => {
    const patch = route.request().postDataJSON() as { tunnel?: Record<string, unknown> };
    if (patch.tunnel !== undefined) tunnel = patch.tunnel;
    await route.fulfill({ json: { settings: settings() } });
  });

  await page.goto(`${cockpit.url}/settings/remote`);
  await expect(page.getByTestId('settings-section-remote')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('remote-tunnel-quick')).toHaveAttribute('data-state', 'checked');

  await page.getByTestId('remote-tunnel-named').click();
  await page.getByTestId('remote-tunnel-hostname').fill('https://doom.example.com');
  await expect(page.getByTestId('remote-tunnel-save')).toBeDisabled();
  await expect(page.getByTestId('remote-tunnel-settings')).toContainText('without https://');

  await page.getByTestId('remote-tunnel-hostname').fill('doom.example.com');
  await page.getByTestId('remote-tunnel-token-file').fill('/Users/me/.cloudflared/doompi.token');
  await page.getByText('locally managed tunnel options').click();
  await page.getByTestId('remote-tunnel-name').fill('doompi');
  await page.getByTestId('remote-tunnel-save').click();
  await expect(page.getByTestId('remote-tunnel-save')).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId('remote-tunnel-named')).toHaveAttribute('data-state', 'checked');
  await expect(page.getByTestId('remote-tunnel-hostname')).toHaveValue('doom.example.com');
  await expect(page.getByTestId('remote-tunnel-token-file')).toHaveValue('/Users/me/.cloudflared/doompi.token');
  await page.getByText('locally managed tunnel options').click();
  await expect(page.getByTestId('remote-tunnel-name')).toHaveValue('doompi');
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

test('requests browser notification permission from the settings button', async ({ page, cockpit }) => {
  await page.addInitScript(() => {
    class NotificationStub {
      static permission = 'default';
      static requestPermission(): Promise<'granted'> {
        (window as typeof window & { notificationPermissionRequested?: boolean }).notificationPermissionRequested =
          true;
        NotificationStub.permission = 'granted';
        return Promise.resolve('granted');
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationStub });
  });

  await page.goto(`${cockpit.url}/settings/notifications`);
  await expect(page.getByTestId('settings-section-notifications')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('notification-permission-status')).toContainText('has not been decided');
  await page.getByTestId('notification-permission-request').click();
  await expect(page.getByTestId('notification-permission-status')).toContainText('are allowed');
  expect(
    await page.evaluate(
      () => (window as typeof window & { notificationPermissionRequested?: boolean }).notificationPermissionRequested,
    ),
  ).toBe(true);
});

test('lists no plugins for the packaged bundle and nothing to resolve', async ({ page, cockpit }) => {
  await page.goto(`${cockpit.url}/settings/plugins`);
  await expect(page.getByTestId('settings-section-plugins')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('settings-plugins-empty')).toBeVisible();
  await expect(page.getByTestId('settings-plugin-diagnostics-empty')).toBeVisible();
});

test('reads and writes the image limits on the images page', async ({ page, cockpit }) => {
  let images = { autoResize: true, maxDimension: 2000, minDimension: 256, maxAllowedDimension: 2000 };
  await page.route('**/api/settings/images', async (route) => {
    if (route.request().method() === 'PUT') {
      const patch = route.request().postDataJSON() as { autoResize?: boolean; maxDimension?: number };
      images = { ...images, ...patch };
    }
    await route.fulfill({ json: images });
  });

  await page.goto(`${cockpit.url}/settings/images`);
  await expect(page.getByTestId('settings-section-images')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('image-max-dimension')).toHaveValue('2000');

  // A typed cap saves on its own button, so the field is dirty until then.
  await page.getByTestId('image-max-dimension').fill('1024');
  await page.getByTestId('image-max-dimension-save').click();
  await expect(page.getByTestId('image-max-dimension-save')).toBeDisabled();
  expect(images.maxDimension).toBe(1024);

  // The toggle applies at once, and turning it off locks the cap with it.
  await page.getByTestId('image-auto-resize').click();
  await expect(page.getByTestId('image-max-dimension')).toBeDisabled();
  expect(images.autoResize).toBe(false);
});
test.describe('with the synced bundle', () => {
  test.use({ assets: 'synced' });

  test('lists every bundled plugin with its contributions and no diagnostics', async ({ page, cockpit }) => {
    await page.goto(`${cockpit.url}/settings/plugins`);
    await expect(page.getByTestId('settings-plugin-subagents')).toContainText('1 activity groups');
    await expect(page.getByTestId('settings-plugin-subagents')).toContainText('1 slots');
    await expect(page.getByTestId('settings-plugin-runner')).toContainText('1 activity groups');
    await expect(page.getByTestId('settings-plugin-workflows')).toBeVisible();
    await expect(page.getByTestId('settings-plugin-diagnostics-empty')).toBeVisible();
  });
});

// The metrics page is contributed by doompi-log, so it exists only in the
// synced-style bundle the Playwright global setup composes from every
// workspace plugin. The package's own dist ships the shell with an empty
// plugin registry.
test.describe('with the synced bundle, which carries the doompi-log metrics page', () => {
  test.use({ assets: 'synced' });

  test('opens the metrics page and settles on a state it can name', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();

    await page.getByTestId('settings-open').click();
    await page.getByTestId('settings-section-metrics').click();
    await expect(page).toHaveURL(/\/settings\/metrics$/);

    // The page is drawn by the package rather than rendered from declared
    // fields, so reaching it exercises the whole settings-panel contribution.
    await expect(page.getByTestId('settings-panel-metrics')).toBeVisible();
    await expect(page.getByTestId('metrics-panel')).toBeVisible();

    // Whether a log sink runs is a property of the machine, not of the
    // cockpit, so this asserts the page reaches a state it can explain rather
    // than pinning one of them. An unexplained error is the actual failure.
    await expect(page.getByTestId('metrics-empty').or(page.getByTestId('metrics-group-bars'))).toBeVisible({
      timeout: FIRST_READ_MS,
    });
    await expect(page.getByTestId('metrics-error')).toHaveCount(0);
  });
});
