import { expect, test } from '../support/cockpit';

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
  cockpit.session.setSessionStats({
    tokens: { input: 50_000, output: 10_000, total: 105_000 },
    cost: 0.84,
    contextUsage: { tokens: 82_400, contextWindow: 200_000 },
  });
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');

  // The gauge rounds what Pi reports as a raw float.
  await expect(page.getByTestId('top-context')).toHaveText('ctx 41%');
  await expect(page.getByTestId('top-cost')).toHaveText('$0.84');
});

test('raises the cost while a message is still streaming', async ({ page, cockpit }) => {
  cockpit.session.setSessionStats({ tokens: { total: 105_000 }, cost: 0.84 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');
  await expect(page.getByTestId('top-cost')).toHaveText('$0.84');

  // Pi reports the in-progress message's own usage, so the chip has to add it
  // to the last figure rather than wait for the turn to settle.
  cockpit.session.emit({ type: 'message_update', usage: { cost: { total: 0.07 } } });
  await expect(page.getByTestId('top-cost')).toHaveText('$0.91');
});

test('asks for the usage figures once a message lands', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');
  const before = cockpit.session.received.filter((frame) => frame.type === 'get_session_stats').length;

  cockpit.session.emit({ type: 'message_end' });

  await expect
    .poll(() => cockpit.session.received.filter((frame) => frame.type === 'get_session_stats').length)
    .toBeGreaterThan(before);
});

test('folds subagent spend into one cost figure', async ({ page, cockpit }) => {
  cockpit.session.setSessionStats({ tokens: { total: 105_000 }, cost: 1.84 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_session_stats');
  await expect(page.getByTestId('top-cost')).toHaveText('$1.84');

  // Subagents bill to sessions of their own; the team package reports their
  // total the same way any package reports a footer status.
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'st-doom-team-cost',
    method: 'setStatus',
    statusKey: 'doom-team-cost',
    statusText: '0.57',
  });

  await expect(page.getByTestId('top-cost')).toHaveText('$2.41');
  await expect(page.getByTestId('top-cost')).toHaveAttribute('title', /\$1\.84 session \+ \$0\.57 agents/);
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
