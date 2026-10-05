import { createHostHandshake, type SealedChannel } from '@agimon-ai/doompi-web-security/node';
import type { Page } from '@playwright/test';

import { expect, test } from '../support/cockpit';

const TUNNEL_HOST = 'calm-river-1234.trycloudflare.com';
const SIGNER_PUBLIC_KEY = 'A'.repeat(90);
const PAIR_URL = `https://${TUNNEL_HOST}/pair#c=${'C'.repeat(24)}&k=${'K'.repeat(43)}&s=${SIGNER_PUBLIC_KEY}&r=1`;

/** The state the hub reports once a tunnel is up, so the UI can be driven without one. */
function liveState(devices: unknown[] = [], pending: unknown[] = []) {
  return {
    state: {
      status: 'on',
      publicUrl: `https://${TUNNEL_HOST}`,
      devices,
      pending,
      settings: {
        autoCloseEnabled: true,
        autoCloseMinutes: 60,
        sessionExpiryEnabled: true,
        idleMinutes: 30,
        absoluteHours: 12,
        tunnel: { kind: 'quick' },
        sandbox: { enabled: false, workspaces: [] },
      },
    },
  };
}

function offState() {
  const { publicUrl: _publicUrl, ...state } = liveState().state;
  return { state: { ...state, status: 'off' } };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/remote', async (route) => await route.fulfill({ json: offState() }));
});

test('the header button opens remote access on its options, not on a code', async ({ page, cockpit }) => {
  // The bounds belong in front of the decision: turning this on is what puts a
  // shell on this machine within reach of the internet.
  await page.goto(cockpit.url);
  await page.getByTestId('remote-access-open').click();
  await expect(page.getByTestId('remote-access-dialog')).toBeVisible();
  await expect(page.getByTestId('remote-autoclose-switch')).toBeVisible();
  await expect(page.getByTestId('remote-expiry-switch')).toBeVisible();
  await expect(page.getByTestId('remote-access-dialog')).toContainText('run shell commands as you');
  await expect(page.getByTestId('remote-banner')).toBeHidden();
});

test('the pairing step shows a scannable code, manual code, and address', async ({ page, cockpit }) => {
  await page.route('**/api/remote/codes', async (route) => {
    await route.fulfill({
      json: {
        code: 'x',
        manualCode: '12345678',
        pairUrl: PAIR_URL,
        expiresAt: new Date().toISOString(),
        publicKey: SIGNER_PUBLIC_KEY,
        fingerprint: 'f'.repeat(64),
        revision: 1,
      },
    });
  });
  await page.route('**/api/remote/enable', async (route) => await route.fulfill({ json: liveState() }));

  await page.goto(cockpit.url);
  await page.getByTestId('remote-access-open').click();
  await page.getByTestId('remote-access-on').click();

  await expect(page.getByTestId('remote-pair-code')).toHaveText('12345678');
  await expect(page.getByTestId('remote-pair-url')).toHaveText(PAIR_URL);
  await expect(page.locator('[data-testid="remote-access-dialog"] svg[role="img"]')).toBeVisible();
  // Unmissable while the tunnel is up, and contained by the rail so it does not
  // add height to the page around the cockpit.
  const banner = page.getByTestId('session-rail-panel').getByTestId('remote-banner');
  await expect(banner).toContainText(TUNNEL_HOST);
  await expect
    .poll(async () => await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight))
    .toBe(true);
});

test('an approval prompt names the device and says what approving grants', async ({ page, cockpit }) => {
  const pending = [
    {
      id: 'req-1',
      userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
      edgeIp: '203.0.113.7',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    },
  ];
  await page.route('**/api/remote', async (route) => await route.fulfill({ json: liveState([], pending) }));

  await page.goto(cockpit.url);
  await expect(page.getByTestId('pairing-approval')).toBeVisible();
  await expect(page.getByTestId('pairing-approval-agent')).toContainText('iPhone');
  await expect(page.getByTestId('pairing-approval')).toContainText('reported by the edge');
  await expect(page.getByTestId('pairing-approve')).toBeVisible();
  await expect(page.getByTestId('pairing-deny')).toBeVisible();
});

test('a pending approval takes over the remote access dialog until it is resolved', async ({ page, cockpit }) => {
  const pending = [
    {
      id: 'req-1',
      userAgent: 'iPhone Safari',
      edgeIp: '203.0.113.7',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    },
  ];
  let reads = 0;
  let denied = false;
  let releasePending!: () => void;
  const dialogOpened = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  await page.route('**/api/remote', async (route) => {
    reads += 1;
    if (reads > 1) await dialogOpened;
    await route.fulfill({ json: liveState([], reads === 1 || denied ? [] : pending) });
  });
  await page.route('**/api/remote/pairing/req-1/deny', async (route) => {
    denied = true;
    await route.fulfill({ json: liveState() });
  });

  await page.goto(cockpit.url);
  await page.getByTestId('remote-access-open').click();
  await expect(page.getByTestId('remote-access-dialog')).toBeVisible();
  releasePending();
  await expect(page.getByTestId('pairing-approval')).toBeVisible();
  await expect(page.getByTestId('remote-access-dialog')).toBeHidden();
  await page.getByTestId('pairing-deny').click();
  await expect(page.getByTestId('pairing-approval')).toBeHidden();
  await expect(page.getByTestId('remote-access-dialog')).toBeVisible();
});

test('the host sees a new pairing request without opening remote access', async ({ page, cockpit }) => {
  const pending = [
    {
      id: 'req-1',
      userAgent: 'iPhone Safari',
      edgeIp: '203.0.113.7',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    },
  ];
  let reads = 0;
  await page.route('**/api/remote', async (route) => {
    reads += 1;
    await route.fulfill({ json: liveState([], reads < 3 ? [] : pending) });
  });

  await page.goto(cockpit.url);
  await expect(page.getByTestId('remote-access-dialog')).toBeHidden();
  await expect(page.getByTestId('pairing-approval')).toBeVisible();
  await expect(page.getByTestId('pairing-approval-agent')).toContainText('iPhone');
});

test('the container switch is off by default and asks for a workspace before it can be used', async ({
  page,
  cockpit,
}) => {
  // Off by default because turning it on changes where every session runs. The
  // workspace list only appears once it is on, because until then it is the
  // answer to a question nobody asked.
  await page.goto(cockpit.url);
  await page.getByTestId('remote-access-open').click();
  const container = page.getByTestId('remote-sandbox-switch');
  await expect(container).toBeVisible();
  await expect(container).toHaveAttribute('data-state', 'unchecked');
  await expect(page.getByTestId('sandbox-workspaces')).toBeHidden();

  await page.route('**/api/remote/settings', async (route) => {
    await route.fulfill({ json: { settings: settingsFrom(route) } });
  });
  await container.click();
  await expect(page.getByTestId('sandbox-workspaces')).toBeVisible();
  await expect(page.getByTestId('sandbox-workspaces')).toContainText('Add at least one');
  // Nothing to add until the path is absolute: a relative one would mount a
  // directory other than the one it names.
  await page.getByTestId('sandbox-workspace-input').fill('repo');
  await expect(page.getByTestId('sandbox-workspace-add')).toBeDisabled();
  await page.getByTestId('sandbox-workspace-input').fill('/repo');
  await expect(page.getByTestId('sandbox-workspace-add')).toBeEnabled();
});

const REMOTE_ORIGIN = 'https://doompi.test';

/** Browser startup against a controlled secure origin, not a real tunnel integration. */
async function remoteStartup(page: Page, localUrl: string, rememberKey: boolean | string = true) {
  const host = createHostHandshake();
  const channels = new Map<string, SealedChannel>();
  const registrations: string[] = [];
  const plaintextRequests: string[] = [];
  const sealedTargets: string[] = [];
  const sockets: string[] = [];
  await page.addInitScript(
    ({ publicKey, remember }) => {
      if (remember) sessionStorage.setItem('doompi.channelKey', typeof remember === 'string' ? remember : publicKey);
      else sessionStorage.removeItem('doompi.channelKey');
    },
    { publicKey: host.publicKey, remember: rememberKey },
  );
  await page.context().addCookies([{ name: 'paired-device', value: 'fixture', url: REMOTE_ORIGIN }]);
  await page.routeWebSocket('wss://doompi.test/**', async (socket) => {
    sockets.push(socket.url());
    await socket.close();
  });
  await page.route(`${REMOTE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/pair') {
      await route.fulfill({ contentType: 'text/html', body: '<h1>Pairing recovery</h1>' });
    } else if (url.pathname.startsWith('/api/')) {
      plaintextRequests.push(url.pathname);
      await route.fulfill({ status: 401, json: { error: 'Remote HTTP requests must use the sealed gateway.' } });
    } else {
      const response = await route.fetch({ url: `${localUrl}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    }
  });
  await page.route(`${REMOTE_ORIGIN}/api/remote/request`, async (route) => {
    const channel = channels.get('http');
    if (channel === undefined) throw new Error('HTTP requested before its channel registration.');
    const opened = channel.open(route.request().postDataJSON());
    if (!opened.ok) throw new Error(`The gateway could not open the request: ${opened.failure}`);
    const request = JSON.parse(Buffer.from(opened.plaintext).toString()) as { method: string; target: string };
    sealedTargets.push(request.target);
    // No trusted worker is installed at this controlled origin. Exercise startup
    // and configuration through the existing composition-error recovery layout.
    const response =
      request.target === '/api/compositions'
        ? { status: 503, body: Buffer.from('{"error":"fixture composition unavailable"}') }
        : await (async () => {
            const upstream = await route.fetch({ url: `${localUrl}${request.target}`, method: request.method });
            return { status: upstream.status(), body: await upstream.body() };
          })();
    const sealed = channel.seal(
      Buffer.from(
        JSON.stringify({
          v: 1,
          status: response.status,
          headers: [['content-type', 'application/json']],
          body: response.body.toString('base64'),
        }),
      ),
    );
    if (!sealed.ok) throw new Error(`The gateway could not seal the response: ${sealed.failure}`);
    await route.fulfill({ json: sealed.envelope });
  });
  return { host, channels, registrations, plaintextRequests, sealedTargets, sockets };
}

test('remote startup waits for every channel before settings, compositions and sockets', async ({
  page,
  cockpit,
}, testInfo) => {
  const startup = await remoteStartup(page, cockpit.url);
  let releaseHttp!: () => void;
  const httpAllowed = new Promise<void>((resolve) => {
    releaseHttp = resolve;
  });
  await page.route(`${REMOTE_ORIGIN}/api/remote/channel`, async (route) => {
    const registration = route.request().postDataJSON() as { scope: string; clientPublicKey: string };
    startup.registrations.push(registration.scope);
    const channel = startup.host.accept(registration.clientPublicKey);
    if (channel === undefined) throw new Error('The host refused a valid fixture client key.');
    startup.channels.set(registration.scope, channel);
    if (registration.scope === 'http') await httpAllowed;
    await route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${REMOTE_ORIGIN}/settings/appearance`);
  try {
    await expect.poll(() => startup.registrations).toEqual(['session', 'protocol', 'http']);
    await expect(page.getByTestId('connection-loading')).toBeVisible();
    const screenshotPath = testInfo.outputPath('mobile-connection-loading.png');
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('mobile-connection-loading', { path: screenshotPath, contentType: 'image/png' });
    await expect(page.getByTestId('settings-section-appearance')).toHaveCount(0);
    expect(startup.plaintextRequests).toEqual([]);
    expect(startup.sealedTargets).toEqual([]);
    expect(startup.sockets).toEqual([]);
  } finally {
    releaseHttp();
  }
  await expect(page.getByTestId('settings-section-appearance')).toHaveAttribute('data-active', 'true');
  await expect.poll(() => startup.sealedTargets.some((target) => target.startsWith('/api/settings?'))).toBe(true);
  expect(startup.sealedTargets).toContain('/api/compositions');
  await expect.poll(() => startup.sockets.length).toBeGreaterThan(0);
  expect(startup.registrations).toEqual(['session', 'protocol', 'http']);
  expect(startup.plaintextRequests).toEqual([]);
  await expect(page.getByTestId('connection-loading')).toHaveCount(0);
  await expect(page.getByTestId('connection-error')).toHaveCount(0);
});

for (const refusedScope of ['protocol', 'http']) {
  test(`remote startup refuses consumers when ${refusedScope} registration fails`, async ({ page, cockpit }) => {
    const startup = await remoteStartup(page, cockpit.url);
    await page.route(`${REMOTE_ORIGIN}/api/remote/channel`, async (route) => {
      const registration = route.request().postDataJSON() as { scope: string; clientPublicKey: string };
      startup.registrations.push(registration.scope);
      await route.fulfill({ status: registration.scope === refusedScope ? 401 : 200, json: { ok: true } });
    });
    await page.goto(`${REMOTE_ORIGIN}/settings/appearance`);
    await expect(page.getByTestId('connection-error')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in or pair again' })).toHaveAttribute('href', '/pair');
    await expect(page.getByTestId('settings-section-appearance')).toHaveCount(0);
    await expect(page.getByTestId('template-loading')).toHaveCount(0);
    expect(startup.registrations).toContain(refusedScope);
    expect(startup.plaintextRequests).toEqual([]);
    expect(startup.sealedTargets).toEqual([]);
    expect(startup.sockets).toEqual([]);
    expect(page.url()).toBe(`${REMOTE_ORIGIN}/settings/appearance`);
  });
}

test('remote startup with a missing tab key offers explicit pairing recovery', async ({ page, cockpit }, testInfo) => {
  const startup = await remoteStartup(page, cockpit.url, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(REMOTE_ORIGIN);
  await expect(page.getByTestId('connection-error')).toBeVisible();
  const screenshotPath = testInfo.outputPath('mobile-connection-recovery.png');
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('mobile-connection-recovery', { path: screenshotPath, contentType: 'image/png' });
  expect(startup.plaintextRequests).toEqual([]);
  expect(startup.sealedTargets).toEqual([]);
  expect(startup.sockets).toEqual([]);
  expect(page.url()).toBe(`${REMOTE_ORIGIN}/`);
  await page.getByRole('link', { name: 'Sign in or pair again' }).click();
  await expect(page).toHaveURL(`${REMOTE_ORIGIN}/pair`);
  await expect(page.getByRole('heading', { name: 'Pairing recovery' })).toBeVisible();
});

test('remote startup handles restoration failure for an invalid remembered key', async ({ page, cockpit }) => {
  const startup = await remoteStartup(page, cockpit.url, 'not-a-channel-key');
  await page.goto(REMOTE_ORIGIN);
  await expect(page.getByTestId('connection-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in or pair again' })).toHaveAttribute('href', '/pair');
  expect(startup.plaintextRequests).toEqual([]);
  expect(startup.sealedTargets).toEqual([]);
  expect(startup.sockets).toEqual([]);
});

/** Echoes the settings a PUT carried, which is what the hub does after clamping. */
function settingsFrom(route: { request: () => { postDataJSON: () => unknown } }): Record<string, unknown> {
  const patch = route.request().postDataJSON() as Record<string, unknown>;
  return {
    autoCloseEnabled: true,
    autoCloseMinutes: 60,
    sessionExpiryEnabled: true,
    idleMinutes: 30,
    absoluteHours: 12,
    tunnel: { kind: 'quick' },
    sandbox: { enabled: false, workspaces: [] },
    ...patch,
  };
}
