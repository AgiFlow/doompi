import { spawn } from 'node:child_process';
import { expect, test } from '../support/cockpit.ts';
import { startFakeSession } from '../support/fakeSession.ts';

test.use({ sessionCount: 2 });

test('renames a session through the agent and shows the name it reports back', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  const card = page.getByTestId('session-card-s1');
  await expect(card).toBeVisible();

  await card.hover();
  await page.getByTestId('session-menu-s1').click();
  await page.getByTestId('session-rename-s1').click();
  await page.getByTestId('session-name-input-s1').fill('gate-review');
  await page.keyboard.press('Enter');

  const sent = await cockpit.session.waitForCommand('set_session_name');
  expect(sent.name).toBe('gate-review');
  // The agent owns the name; the hub reads it back from state, like any page would.
  cockpit.session.emit({ type: 'response', command: 'get_state', success: true, data: { sessionName: 'gate-review' } });
  await expect(card).toContainText('gate-review');
});

test('stops a session from its card once the stop is confirmed', async ({ page, cockpit }) => {
  // A throwaway process stands in for the session's server: the hub signals
  // its pid, and the watcher withdraws the dead record on its next poll.
  const server = spawn('sleep', ['60'], { stdio: 'ignore' });
  if (server.pid === undefined) throw new Error('could not start the stand-in server process');
  const doomed = await startFakeSession({
    id: 'doomed',
    name: 'doomed',
    registryDir: cockpit.registryDir,
    pid: server.pid,
  });
  try {
    await page.goto(cockpit.url);
    const card = page.getByTestId('session-card-doomed');
    await expect(card).toBeVisible();

    await card.hover();
    await page.getByTestId('session-menu-doomed').click();
    await page.getByTestId('session-stop-doomed').click();
    await expect(page.getByTestId('session-stop-dialog-doomed')).toBeVisible();
    await page.getByTestId('session-stop-confirm-doomed').click();

    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => server.exitCode !== null || server.signalCode !== null).toBe(true);
  } finally {
    await doomed.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
  }
});

test('lists every running session in the rail with its ordinal', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await expect(page.getByTestId('session-card-s1')).toBeVisible();
  await expect(page.getByTestId('session-card-s2')).toBeVisible();
  await expect(page.getByTestId('session-card-s1')).toContainText('session-1');
  await expect(page.getByTestId('session-card-s2')).toContainText('session-2');
  await expect(page.getByTestId('sessions-running-rail')).toHaveText('0 running');

  // The first session gets the focus, visibly.
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'false');
});

test('updates a card live while its session is not focused', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  cockpit.sessions[1].emit({ type: 'agent_start' });

  const status = page.getByTestId('session-card-s2').getByTestId('session-card-status');
  await expect(status).toContainText('running ·');
  await expect(page.getByTestId('sessions-running-rail')).toHaveText('1 running');
  await expect(page.getByTestId('sessions-running')).toHaveText('1 running');
  // The focused timeline stays that of session one.
  await expect(page.getByTestId('timeline-empty')).toBeVisible();

  cockpit.sessions[1].emit({ type: 'agent_settled' });
  await expect(status).toContainText('finished its work');
});

test('switches focus by card click and by ordinal digit', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  cockpit.sessions[1].emit({ type: 'agent_start' });
  cockpit.sessions[1].emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'from session two' },
  });

  await page.getByTestId('session-card-s2').click();
  await expect(page).toHaveURL(/\/session\/s2$/);
  // The timeline catches up from the hub's ring.
  await expect(page.getByTestId('entry-assistant')).toContainText('from session two');
  await expect(page.getByTestId('top-cwd')).toBeVisible();

  await page.keyboard.press('1');
  await expect(page).toHaveURL(/\/session\/s1$/);
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
});

test('keeps a refusal scoped to the session it hits', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  const release = await cockpit.sessions[1].holdFromAnotherClient();

  // The rail reports it; the overlay stays away while another session is focused.
  const status = page.getByTestId('session-card-s2').getByTestId('session-card-status');
  await expect(status).toHaveText('another cockpit holds this session');
  await expect(page.getByTestId('refused-card')).toBeHidden();

  await page.getByTestId('session-card-s2').click();
  await expect(page.getByTestId('refused-card')).toBeVisible();

  release();
  // Recovery rides the hub's backoff, whose ceiling is 4s.
  await expect(page.getByTestId('refused-card')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('connection-status')).toHaveText(/attached/, { timeout: 15_000 });
});

test('creates a session from the dialog and lands on it', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  await page.getByTestId('new-session-open').click();
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  // The cwd is prefilled from the focused session; any real directory works
  // for the registering stand-in.
  await page.getByTestId('new-session-name').fill('fresh');
  await page.getByTestId('new-session-create').click();

  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByTestId('session-title')).toHaveText('fresh');
});

test('opens the dialog with ctrl+t and closes it with escape', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toBeVisible();

  await page.keyboard.press('Control+t');
  await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-session-dialog')).toBeHidden();
});

test.describe('when the server cannot be launched', () => {
  test.use({ spawnStub: 'fail' });

  test('shows the failure in the dialog instead of navigating', async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await expect(page.getByTestId('session-card-s1')).toBeVisible();

    await page.getByTestId('new-session-open').click();
    await page.getByTestId('new-session-create').click();

    await expect(page.getByTestId('new-session-error')).toContainText('exited with code 3', { timeout: 15_000 });
    await expect(page.getByTestId('new-session-dialog')).toBeVisible();
  });
});
