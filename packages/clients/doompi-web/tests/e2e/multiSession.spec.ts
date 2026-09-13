import { expect, test } from '../support/cockpit';

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

test('renames the focused session by clicking its title in the top bar', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  // The title is the affordance: no menu, no second place to look.
  await page.getByTestId('session-title').click();
  await page.getByTestId('session-title-input').fill('gate-review');
  await page.keyboard.press('Enter');

  const sent = await cockpit.session.waitForCommand('set_session_name');
  expect(sent.name).toBe('gate-review');
  // The same door the rail's rename uses: the agent owns the name and reports
  // it back, so the title only changes once the session says so.
  cockpit.session.emit({ type: 'response', command: 'get_state', success: true, data: { sessionName: 'gate-review' } });
  await expect(page.getByTestId('session-title')).toContainText('gate-review');
});

test('leaves the name alone when a title edit is abandoned', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('session-title')).toHaveText('session-1');
  const before = await page.getByTestId('session-title').innerText();

  await page.getByTestId('session-title').click();
  await page.getByTestId('session-title-input').fill('not-this');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('session-title')).toHaveText(before);
});

test('lists every session in the rail with its ordinal', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  await expect(page.getByTestId('session-card-s1')).toBeVisible();
  await expect(page.getByTestId('session-card-s2')).toBeVisible();
  await expect(page.getByTestId('session-card-s1')).toContainText('session-1');
  await expect(page.getByTestId('session-card-s2')).toContainText('session-2');

  // The first session gets the focus, visibly.
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('session-card-s2')).toHaveAttribute('data-active', 'false');
});

test('updates a card live while its session is not focused', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  cockpit.sessions[1].emit({ type: 'agent_start' });

  const status = page.getByTestId('session-card-s2').getByTestId('session-status');
  await expect(status).toContainText('running ·');
  // The focused timeline stays that of session one.
  await expect(page.getByTestId('timeline-empty')).toBeVisible();

  cockpit.sessions[1].emit({ type: 'agent_settled' });
  await expect(status).toContainText('done · waiting for you');
});

test('switches focus by card click and by ordinal digit', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  cockpit.sessions[1].emit({ type: 'agent_start' });
  cockpit.sessions[1].emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'from session two' },
  });
  cockpit.sessions[1].emit({ type: 'agent_settled' });

  await page.getByTestId('session-card-s2').click();
  await expect(page).toHaveURL(/\/session\/s2$/);
  // The timeline catches up from the hub's ring.
  await expect(page.getByTestId('entry-assistant')).toContainText('from session two');
  await expect(page.getByTestId('session-title')).toBeVisible();

  await page.keyboard.press('1');
  await expect(page).toHaveURL(/\/session\/s1$/);
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
});

test('keeps unfinished composer input scoped to each session', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  const input = page.getByTestId('composer-input');

  await input.fill('draft for session one');
  await page.getByTestId('session-card-s2').click();
  await expect(page).toHaveURL(/\/session\/s2$/);
  await expect(input).toHaveValue('');

  await input.fill('draft for session two');
  await page.getByTestId('session-card-s1').click();
  await expect(input).toHaveValue('draft for session one');

  await page.getByTestId('session-card-s2').click();
  await expect(input).toHaveValue('draft for session two');
});

test('keeps the focused session usable while another client is attached elsewhere', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('session-card-s1')).toHaveAttribute('data-active', 'true');

  const release = await cockpit.sessions[1].connectAnotherClient();

  await expect(page.getByTestId('refused-card')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeEnabled();

  await release();
});
