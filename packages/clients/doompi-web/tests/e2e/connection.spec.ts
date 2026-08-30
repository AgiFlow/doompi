import { expect, test } from '../support/cockpit.ts';

test('attaches to the session', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await expect(page.getByTestId('cockpit')).toBeVisible();
  await cockpit.session.waitForAttach();
});

test('pulls the session facts as soon as it attaches', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await cockpit.session.waitForCommand('get_state');
  await cockpit.session.waitForCommand('get_session_stats');
  await cockpit.session.waitForCommand('get_commands');
});

test('recovers the frames the hub missed while its socket was down', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.dropClient();
  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'recovered after the drop' },
  });

  // The hub reattaches on its own and streams the replay through.
  await expect(page.getByTestId('entry-assistant')).toContainText('recovered after the drop');

  // A reloaded page replays that history from the hub's ring. The replay is
  // not announced: it is how the page is supposed to work, not news, and the
  // count told a reader nothing they could act on. A dropped frame still is.
  await page.reload();
  await expect(page.getByTestId('entry-assistant')).toContainText('recovered after the drop');
  await expect(page.getByTestId('replayed-count')).toHaveCount(0);
});

test('shows an empty timeline before anything happens', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
});
