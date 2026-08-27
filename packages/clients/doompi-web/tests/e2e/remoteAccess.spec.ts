import { expect, test } from '../support/cockpit.ts';

const PAIR_URL = 'https://calm-river-1234.trycloudflare.com/pair#c=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
const TUNNEL_HOST = 'calm-river-1234.trycloudflare.com';

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

test('the pairing step shows a scannable code and the address behind it', async ({ page, cockpit }) => {
  await page.route('**/api/remote/codes', async (route) => {
    await route.fulfill({ json: { code: 'x', pairUrl: PAIR_URL, expiresAt: new Date().toISOString() } });
  });
  await page.route('**/api/remote/enable', async (route) => await route.fulfill({ json: liveState() }));

  await page.goto(cockpit.url);
  await page.getByTestId('remote-access-open').click();
  await page.getByTestId('remote-access-on').click();

  await expect(page.getByTestId('remote-pair-url')).toHaveText(PAIR_URL);
  await expect(page.locator('[data-testid="remote-access-dialog"] svg[role="img"]')).toBeVisible();
  // Unmissable while the tunnel is up, and it names the host so a forgotten
  // tunnel is obvious from across the room.
  await expect(page.getByTestId('remote-banner')).toContainText(TUNNEL_HOST);
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
