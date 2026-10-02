import { expect, test } from '../support/cockpit';

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

test('views queued follow-ups and can delete the queue', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('composer-input').fill('then run the packed-install gate');
  await page.getByTestId('composer-queue').click();
  await cockpit.session.waitForCommand('enqueue_automatic');
  await page.getByTestId('composer-input').fill('then report the bundle size');
  await page.getByTestId('composer-queue').click();
  await expect
    .poll(() => cockpit.session.received.filter((frame) => frame.type === 'enqueue_automatic').length)
    .toBe(2);

  await expect(page.getByTestId('entry-queued')).toHaveCount(0);
  await expect(page.getByTestId('composer-queued')).toContainText('2 queued messages');
  await page.getByTestId('composer-queued').click();

  await expect(page.getByTestId('queue-sheet')).toBeVisible();
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(2);
  await expect(page.getByTestId('queue-sheet')).toContainText('then run the packed-install gate');
  await expect(page.getByTestId('queue-sheet')).toContainText('then report the bundle size');

  await page.getByTestId('queue-delete-0').click();
  await cockpit.session.waitForCommand('remove_queued');
  await expect
    .poll(() => cockpit.session.received.filter((frame) => frame.type === 'enqueue_automatic').at(-1)?.message)
    .toBe('then report the bundle size');
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
  await expect(page.getByTestId('queue-sheet')).not.toContainText('then run the packed-install gate');
  await expect(page.getByTestId('queue-sheet')).toContainText('then report the bundle size');
  await page.getByTestId('queue-clear').click();
  await expect.poll(() => cockpit.session.received.filter((frame) => frame.type === 'clear_queue').length).toBe(1);
  await expect(page.getByTestId('queue-sheet')).toBeHidden();
  await expect(page.getByTestId('composer-queued')).toBeHidden();
});

for (const state of ['idle', 'paused', 'active']) {
  test(`sends one selected queued message while ${state} and preserves the other`, async ({ page, cockpit }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();
    cockpit.session.emit({
      type: 'lifecycle_update',
      lifecycle: {
        revision: 5,
        operation: state === 'active' ? { id: 'clicked-run', kind: 'run', status: 'open' } : null,
        paused: state === 'paused',
        queue: [],
      },
    });
    for (const text of ['send this one', 'keep the other']) {
      await page.getByTestId('composer-input').fill(text);
      await page.getByTestId('composer-queue').click();
      await expect(page.getByTestId('composer-input')).toHaveValue('');
    }
    await page.getByTestId('composer-queued').click();
    await expect(page.getByTestId('queue-steer-0')).toHaveText(
      state === 'active' ? 'interrupt and respond' : 'send now',
    );
    await page.getByTestId('queue-steer-0').click();
    const promoted = await cockpit.session.waitForCommand('promote_queued');
    expect(promoted.operationId).toBe(state === 'active' ? 'clicked-run' : undefined);
    expect(typeof promoted.id).toBe('string');
    await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
    await expect(page.getByTestId('queue-sheet-item')).toContainText('keep the other');
    await expect(page.getByTestId('entry-user')).toHaveCount(1);
    await expect(page.getByTestId('entry-user')).toContainText('send this one');
    await expect(page.getByTestId('queue-resume')).toBeVisible();
    expect(cockpit.session.received.filter(({ type }) => type === 'promote_queued')).toHaveLength(1);
    expect(cockpit.session.received.some(({ type }) => type === 'resume_queue' || type === 'remove_queued')).toBe(
      false,
    );
  });
}

test('keeps a queued row and shows acknowledged deletion failure', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await page.getByTestId('composer-input').fill('keep me on failure');
  await page.getByTestId('composer-queue').click();
  await expect(page.getByTestId('composer-queued')).toBeVisible();
  await page.getByTestId('composer-queued').click();
  cockpit.session.deferCommand('remove_queued');
  await page.getByTestId('queue-delete-0').click();
  await cockpit.session.waitForCommand('remove_queued');
  await expect(page.getByTestId('queue-delete-0')).toBeDisabled();
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
  cockpit.session.emit({ type: 'response', command: 'remove_queued', success: true, data: 'in_flight' });
  await expect(page.getByTestId('queue-error')).toContainText('already being delivered');
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
  await expect(page.getByTestId('queue-delete-0')).toBeEnabled();
});

test('captures the clicked run and explains a raced replacement without resending', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({
    type: 'lifecycle_update',
    lifecycle: {
      revision: 5,
      operation: { id: 'clicked-run', kind: 'run', status: 'open' },
      paused: false,
      queue: [
        {
          id: 'selected',
          text: 'not for another run',
          delivery: 'followUp',
          scheduling: 'automatic',
          disposition: 'pending',
        },
      ],
    },
  });
  await page.getByTestId('composer-queued').click();
  cockpit.session.deferCommand('promote_queued');
  await page.getByTestId('queue-steer-0').click();
  const promoted = await cockpit.session.waitForCommand('promote_queued');
  expect(promoted).toMatchObject({ id: 'selected', operationId: 'clicked-run' });
  await expect(page.getByTestId('queue-steer-0')).toBeDisabled();
  cockpit.session.emit({
    type: 'lifecycle_update',
    lifecycle: {
      revision: 6,
      operation: { id: 'new-run', kind: 'run', status: 'open' },
      paused: false,
      queue: [
        {
          id: 'selected',
          text: 'not for another run',
          delivery: 'followUp',
          scheduling: 'automatic',
          disposition: 'pending',
        },
      ],
    },
  });
  cockpit.session.emit({ type: 'response', command: 'promote_queued', success: true, data: 'promoted' });
  await expect(page.getByTestId('queue-error')).toContainText('active run changed');
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
  await expect(page.getByTestId('entry-user')).toHaveCount(0);
  expect(cockpit.session.received.filter(({ type }) => type === 'promote_queued')).toHaveLength(1);
});

test('keeps protected clear-all rows after acknowledgement and closes only after authoritative emptiness', async ({
  page,
  cockpit,
}) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({
    type: 'lifecycle_update',
    lifecycle: {
      revision: 5,
      operation: null,
      paused: true,
      queue: [
        { id: 'pending', text: 'clear this', delivery: 'followUp', scheduling: 'automatic', disposition: 'pending' },
        {
          id: 'protected',
          text: 'uncertain delivery',
          delivery: 'followUp',
          scheduling: 'automatic',
          disposition: 'uncertain',
        },
      ],
    },
  });
  await page.getByTestId('composer-queued').click();
  cockpit.session.deferCommand('clear_queue');
  await page.getByTestId('queue-clear').click();
  await cockpit.session.waitForCommand('clear_queue');
  await expect(page.getByTestId('queue-clear')).toBeDisabled();
  await expect(page.getByTestId('queue-sheet')).toBeVisible();
  cockpit.session.emit({ type: 'response', command: 'clear_queue', success: false, error: 'Server rejected clear.' });
  await expect(page.getByTestId('queue-error')).toContainText('Internal server error');
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(2);
  await page.getByTestId('queue-clear').click();
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(1);
  await expect(page.getByTestId('queue-clear-remaining')).toContainText('cannot be cleared');
  await expect(page.getByTestId('queue-sheet')).toBeVisible();
  cockpit.session.emit({
    type: 'lifecycle_update',
    lifecycle: { revision: 8, operation: null, paused: true, queue: [] },
  });
  await expect(page.getByTestId('queue-sheet')).toBeHidden();
});

test('does not close clear-all when an empty lifecycle arrives before its acknowledgement', async ({
  page,
  cockpit,
}) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await page.getByTestId('composer-input').fill('clear after acknowledgement');
  await page.getByTestId('composer-queue').click();
  await expect(page.getByTestId('composer-queued')).toBeVisible();
  await page.getByTestId('composer-queued').click();
  cockpit.session.deferCommand('clear_queue');
  await page.getByTestId('queue-clear').click();
  await cockpit.session.waitForCommand('clear_queue');
  cockpit.session.emit({
    type: 'lifecycle_update',
    lifecycle: { revision: 5, operation: null, paused: false, queue: [] },
  });
  await expect(page.getByTestId('queue-sheet-item')).toHaveCount(0);
  await expect(page.getByTestId('queue-sheet')).toBeVisible();
  cockpit.session.emit({
    type: 'response',
    command: 'clear_queue',
    success: true,
    data: { steering: [], followUp: [] },
  });
  await expect(page.getByTestId('queue-sheet')).toBeHidden();
});

test('keeps queued input visible through abort and resumes only when requested', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({ type: 'agent_start' });
  await expect(page.getByTestId('composer-abort')).toBeVisible();
  await page.getByTestId('composer-input').fill('keep this input');
  await page.getByTestId('composer-queue').click();
  await cockpit.session.waitForCommand('enqueue_automatic');
  await expect(page.getByTestId('composer-queued')).toContainText('1 queued message');
  await page.getByTestId('composer-abort').click();
  await cockpit.session.waitForCommand('abort');
  await expect(page.getByTestId('composer-abort')).toContainText('aborting');
  cockpit.session.emit({ type: 'agent_settled' });
  await expect(page.getByTestId('composer-abort')).toBeHidden();
  await page.getByTestId('composer-queued').click();
  await expect(page.getByTestId('queue-sheet-item')).toContainText('keep this input');
  await page.getByTestId('queue-resume').click();
  await cockpit.session.waitForCommand('resume_queue');
  await expect(page.getByTestId('queue-resume')).toBeHidden();
});
test('places one-shot voice transcription into the browser composer', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'voice-result-1',
    method: 'set_editor_text',
    text: 'transcribed on the agent host',
  });

  await expect(page.getByTestId('composer-input')).toHaveValue('transcribed on the agent host');
});

test('stays usable while another authenticated client is attached', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const release = await cockpit.session.connectAnotherClient();

  await expect(page.getByTestId('refused-card')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeEnabled();

  await release();
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

test('links safe URLs in notices, including normalized inline OAuth links, and preserves whitespace', async ({
  page,
  cockpit,
}) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page).toHaveURL(/\/session\/[^/]+$/);
  const currentUrl = page.url();
  const message = [
    'Open this URL:',
    'https://auth.example.com/oauth?client=doom&state=a%26b',
    'Authorize agiflow-mcp by opening: https://example.com',
    'https://user:secret@example.com/private',
    '<b>not markup</b>',
  ].join('\n');

  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'note-link-1',
    method: 'notify',
    message,
  });

  const notice = page.getByTestId('entry-notice');
  await expect(notice).toBeVisible();
  expect(await notice.locator('p').innerText()).toBe(message);
  await expect(notice.locator('a')).toHaveCount(2);
  const authorizationLink = notice.locator('a').first();
  await expect(authorizationLink).toHaveText('https://auth.example.com/oauth?client=doom&state=a%26b');
  await expect(authorizationLink).toHaveAttribute('href', 'https://auth.example.com/oauth?client=doom&state=a%26b');
  await expect(authorizationLink).toHaveAttribute('target', '_blank');
  await expect(authorizationLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(notice.locator('a').nth(1)).toHaveAttribute('href', 'https://example.com/');
  await expect(notice.locator('b')).toHaveCount(0);
  expect(page.url()).toBe(currentUrl);
});

test('shows journaled MCP authorization feedback and its link once', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  const frame = {
    type: 'entry_appended',
    entry: {
      type: 'custom',
      id: 'mcp-auth-feedback',
      customType: 'doom-notification',
      data: {
        version: 1,
        title: 'Pi',
        subtitle: 'doompi',
        body: 'Authorize agiflow-mcp by opening: https://auth.example.com/oauth?state=test',
        level: 'info',
      },
    },
  };
  cockpit.session.emit(frame);
  cockpit.session.emit(frame);
  const notice = page.getByTestId('entry-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Authorize agiflow-mcp');
  await expect(notice.locator('a')).toHaveAttribute('href', 'https://auth.example.com/oauth?state=test');
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
