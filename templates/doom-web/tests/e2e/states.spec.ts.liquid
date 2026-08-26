import { expect, test } from '../support/cockpit.ts';

test('offers suggestions on an empty session and sends one', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('timeline-empty')).toBeVisible();
  await page.getByTestId('suggestion-0').click();

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('review the working tree and summarise the diff');
});

test('marks the end of a run with what it did', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
  cockpit.session.emit({ type: 'tool_execution_end', toolCallId: 'c1', result: {}, isError: false });
  cockpit.session.emit({ type: 'agent_settled' });

  await expect(page.getByTestId('entry-settled')).toContainText('agent settled · 1 tool');
});

test('shows a queued follow-up as queued, not as sent', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('composer-input').fill('then run the packed-install gate');
  await page.getByTestId('composer-queue').click();

  await expect(page.getByTestId('entry-queued')).toContainText('then run the packed-install gate');
  await cockpit.session.waitForCommand('follow_up');
});

test('explains a refused attach instead of sitting blank', async ({ page, cockpit }) => {
  // Hold the session from a second client so the cockpit's attach is refused.
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const intruder = await cockpit.session.holdFromAnotherClient();

  await expect(page.getByTestId('refused-card')).toBeVisible();
  await expect(page.getByTestId('refused-title')).toHaveText('session already attached');
  await expect(page.getByTestId('refused-card')).toContainText('one client at a time');
  // The rail card carries the same story.
  await expect(page.getByTestId('session-status')).toHaveText('another cockpit holds this session');

  intruder();
  // Recovery rides the hub's backoff, whose ceiling is 4s.
  await expect(page.getByTestId('refused-card')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('connection-status')).toHaveText(/attached/, { timeout: 15_000 });
});

test('answers a permission prompt from the keyboard', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'perm-1',
    method: 'select',
    title: 'permission required',
    message: 'rm -rf node_modules/.cache && pnpm install',
    options: ['allow once', 'allow for this session', 'deny'],
  });

  await expect(page.getByTestId('dialog-command')).toBeVisible();
  await page.keyboard.press('2');

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value).toBe('allow for this session');
});

test('a status frame never opens a modal', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'st-1',
    method: 'setStatus',
    statusKey: 'doom-major-mode',
    statusText: '[copilot]',
  });

  await expect(page.getByTestId('selection-mode')).toHaveText('COPILOT');
  await expect(page.getByTestId('dialog')).toBeHidden();
});

test('an informational notice reads as an aside, an error shouts', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'note-1',
    method: 'notify',
    message: 'Plan mode deactivated.',
  });
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'note-2',
    method: 'notify',
    notifyType: 'error',
    message: 'Voice has no actions available in this session.',
  });

  const notices = page.getByTestId('entry-notice');
  await expect(notices).toHaveCount(2);
  // A mode switch is not a failure, so it must not wear the failure colour.
  await expect(notices.nth(0)).toHaveAttribute('data-tone', 'info');
  await expect(notices.nth(1)).toHaveAttribute('data-tone', 'error');
});

test('the activity dock stays hidden across a route change and a reload', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await page.getByTestId('activity-close').click();
  await expect(page.getByTestId('activity-show')).toBeVisible();

  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('activity-show')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('activity-show')).toBeVisible();

  await page.getByTestId('activity-show').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();
});
