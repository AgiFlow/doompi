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
