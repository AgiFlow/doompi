import { expect, test } from '../support/cockpit.ts';

test('sends a prompt and shows it in the timeline', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('composer-input').fill('widen the parity gate');
  await page.getByTestId('composer-send').click();

  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('widen the parity gate');
  await expect(page.getByTestId('entry-user')).toHaveText(/widen the parity gate/);
});

test('streams the assistant reply as it arrives', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'agent_start' });
  cockpit.session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Looking ' } });
  await expect(page.getByTestId('entry-assistant')).toContainText('Looking');
  await expect(page.getByTestId('entry-assistant')).toHaveAttribute('data-streaming', 'true');

  cockpit.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'at the gate.' },
  });
  cockpit.session.emit({ type: 'agent_settled' });

  await expect(page.getByTestId('entry-assistant')).toContainText('Looking at the gate.');
  await expect(page.getByTestId('entry-assistant')).toHaveAttribute('data-streaming', 'false');
});

test('renders a tool call from running to finished', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'pnpm nx test doompi' },
  });

  const card = page.getByTestId('entry-tool');
  await expect(card).toHaveAttribute('data-tool-state', 'running');
  await expect(card).toContainText('pnpm nx test doompi');

  cockpit.session.emit({
    type: 'tool_execution_update',
    toolCallId: 'call-1',
    partialResult: { content: [{ type: 'text', text: 'running 4 tests' }] },
  });
  await expect(page.getByTestId('tool-output')).toContainText('running 4 tests');

  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    result: { content: [{ type: 'text', text: 'Tests 11 passed (11)' }] },
    isError: false,
  });

  await expect(card).toHaveAttribute('data-tool-state', 'ok');
  await expect(page.getByTestId('tool-output')).toContainText('11 passed');
});

test('marks a failed tool call as an error', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-2',
    toolName: 'bash',
    args: { command: 'false' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-2',
    result: { content: [{ type: 'text', text: 'exit 1' }] },
    isError: true,
  });

  await expect(page.getByTestId('entry-tool')).toHaveAttribute('data-tool-state', 'error');
});

test('steers instead of prompting while the agent is running', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'agent_start' });
  await expect(page.getByTestId('composer-send')).toHaveText('steer');

  await page.getByTestId('composer-input').fill('also check the cold start budget');
  await page.getByTestId('composer-send').click();

  const sent = await cockpit.session.waitForCommand('steer');
  expect(sent.message).toBe('also check the cold start budget');
});

test('aborts a running turn', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'agent_start' });
  await page.getByTestId('composer-abort').click();

  await cockpit.session.waitForCommand('abort');
});

test('queues a follow-up', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('composer-input').fill('then run the packed-install gate');
  await page.getByTestId('composer-queue').click();

  const sent = await cockpit.session.waitForCommand('follow_up');
  expect(sent.message).toBe('then run the packed-install gate');
});

test('surfaces an agent error in the timeline', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({ type: 'error', message: 'the provider refused the request' });

  await expect(page.getByTestId('entry-notice')).toContainText('the provider refused the request');
});
