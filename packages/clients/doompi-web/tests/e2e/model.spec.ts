import { expect, test } from '../support/cockpit.ts';

const state = (model: { id: string; provider: string }, thinkingLevel: string) => ({
  type: 'response',
  command: 'get_state',
  success: true,
  data: { model, thinkingLevel, isStreaming: false, sessionId: 'abc', sessionName: 'work', messageCount: 1 },
});

const MODELS = {
  type: 'response',
  command: 'get_available_models',
  success: true,
  data: {
    models: [
      { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', reasoning: true },
      { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true },
      { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false },
    ],
  },
};

const LEVELS = {
  type: 'response',
  command: 'get_available_thinking_levels',
  success: true,
  data: { levels: ['off', 'low', 'medium', 'high', 'max'] },
};

test('picks a model from the chip popup and asks the session to switch', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_state');
  cockpit.session.emit(state({ id: 'gpt-5.6-sol', provider: 'openai' }, 'max'));
  await expect(page.getByTestId('agent-model')).toHaveText('gpt-5.6-sol');

  await page.getByTestId('axis-model').click();
  // Opening asks Pi for both lists; nothing is cached from a previous open.
  await cockpit.session.waitForCommand('get_available_models');
  await cockpit.session.waitForCommand('get_available_thinking_levels');
  cockpit.session.emit(MODELS);
  cockpit.session.emit(LEVELS);

  const popup = page.getByTestId('model-popup');
  await expect(popup.getByTestId('model-openai-gpt-5.6-sol')).toHaveAttribute('data-current', 'true');
  await expect(popup.getByTestId('thinking-max')).toHaveAttribute('data-current', 'true');

  await page.getByTestId('model-filter').fill('dismiss before reopening');
  await page.getByTestId('top-bar').click({ position: { x: 8, y: 8 } });
  await expect(popup).toBeHidden();

  const modelRequests = () => cockpit.session.received.filter((frame) => frame.type === 'get_available_models').length;
  const levelRequests = () =>
    cockpit.session.received.filter((frame) => frame.type === 'get_available_thinking_levels').length;
  await page.getByTestId('axis-model').click();
  await expect.poll(modelRequests).toBe(2);
  await expect.poll(levelRequests).toBe(2);
  cockpit.session.emit(MODELS);
  cockpit.session.emit(LEVELS);
  await expect(popup).toBeVisible();

  await page.getByTestId('model-filter').fill('opus');
  await expect(popup.getByTestId('model-anthropic-claude-haiku-4-5')).toBeHidden();
  await popup.getByTestId('model-anthropic-claude-opus-5').click();

  const sent = await cockpit.session.waitForCommand('set_model');
  expect(sent).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5' });
  await expect(popup).toBeHidden();

  // The chip follows what the session confirms, not the click.
  await expect(page.getByTestId('agent-model')).toHaveText('gpt-5.6-sol');
  cockpit.session.emit(state({ id: 'claude-opus-5', provider: 'anthropic' }, 'high'));
  await expect(page.getByTestId('agent-model')).toHaveText('claude-opus-5');
  await expect(page.getByTestId('agent-thinking')).toHaveText('high');
});

test('picks a thinking level and shows a refused pick', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_state');
  cockpit.session.emit(state({ id: 'gpt-5.6-sol', provider: 'openai' }, 'max'));

  await page.getByTestId('axis-model').click();
  await cockpit.session.waitForCommand('get_available_thinking_levels');
  cockpit.session.emit(LEVELS);

  await page.getByTestId('thinking-low').click();
  const sent = await cockpit.session.waitForCommand('set_thinking_level');
  expect(sent.level).toBe('low');
  await expect(page.getByTestId('model-popup')).toBeHidden();

  cockpit.session.emit({ type: 'response', command: 'set_thinking_level', success: false, error: 'level unsupported' });
  await expect(page.getByText('level unsupported')).toBeVisible();
});

// Plan mode applies its configured planning model and effort as it activates,
// and /effort changes the effort on its own. Nothing on this page asked for
// either, so the pushed frames are all the chip has to follow. Pi has a wire
// event for the level but none for the model, which the runtime journals.
test('follows a model and a thinking level the session switched on its own behalf', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForCommand('get_state');
  cockpit.session.emit(state({ id: 'claude-opus-5', provider: 'anthropic' }, 'medium'));
  await expect(page.getByTestId('agent-thinking')).toHaveText('medium');

  const stateRequests = () => cockpit.session.received.filter((frame) => frame.type === 'get_state').length;
  const asked = stateRequests();
  cockpit.session.emit({ type: 'thinking_level_changed', level: 'max' });

  await expect(page.getByTestId('agent-thinking')).toHaveText('max');
  // The model the same get_state reported is left alone.
  await expect(page.getByTestId('agent-model')).toHaveText('claude-opus-5');
  expect(stateRequests()).toBe(asked);

  cockpit.session.emit({
    type: 'entry_appended',
    entry: {
      id: 'e-model-1',
      type: 'custom',
      customType: 'doom-agent-model',
      data: { provider: 'openai', id: 'gpt-5.6-sol' },
    },
  });

  await expect(page.getByTestId('agent-model')).toHaveText('gpt-5.6-sol');
  // The level the pushed frame set survives the model landing after it.
  await expect(page.getByTestId('agent-thinking')).toHaveText('max');
  expect(stateRequests()).toBe(asked);
});
