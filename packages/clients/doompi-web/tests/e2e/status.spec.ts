import { expect, test } from '../support/cockpit.ts';

test('shows the model and thinking level the session reports', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_state');

  cockpit.session.emit({
    type: 'response',
    command: 'get_state',
    success: true,
    data: {
      model: { id: 'gpt-5.3-codex' },
      thinkingLevel: 'high',
      isStreaming: false,
      sessionId: 'abc123',
      sessionName: 'gate-fix',
      messageCount: 7,
    },
  });

  await expect(page.getByTestId('agent-model')).toHaveText('gpt-5.3-codex');
  await expect(page.getByTestId('agent-thinking')).toHaveText('high');
  // The hub folds the reported name into the summary; the top bar shows it.
  await expect(page.getByTestId('session-title')).toHaveText('gate-fix');
});

test('shows context usage and cost the session reports', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');

  cockpit.session.emit({
    type: 'response',
    command: 'get_session_stats',
    success: true,
    data: {
      tokens: { input: 50_000, output: 10_000, total: 105_000 },
      cost: 0.84,
      contextUsage: { tokens: 82_400, contextWindow: 200_000, percent: 41.245 },
    },
  });

  // The gauge rounds what Pi reports as a raw float.
  await expect(page.getByTestId('top-context')).toHaveText('ctx 41%');
  await expect(page.getByTestId('top-cost')).toHaveText('$0.84');
});

test('folds the run state into the connection pill', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('connection-status')).toHaveText(/attached/);
  cockpit.session.emit({ type: 'agent_start' });
  await expect(page.getByTestId('connection-status')).toHaveText(/running/);
  cockpit.session.emit({ type: 'agent_settled' });
  await expect(page.getByTestId('connection-status')).toHaveText(/attached/);
});

test('refreshes the facts once a run settles', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');
  const before = cockpit.session.received.filter((frame) => frame.type === 'get_session_stats').length;

  cockpit.session.emit({ type: 'agent_settled' });

  await expect
    .poll(() => cockpit.session.received.filter((frame) => frame.type === 'get_session_stats').length)
    .toBeGreaterThan(before);
});
