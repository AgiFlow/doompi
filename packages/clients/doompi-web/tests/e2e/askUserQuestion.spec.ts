import { expect, test } from '../support/cockpit.ts';
import type { FakeSession } from '../support/fakeSession.ts';

// The questionnaire is a plugin contribution, so this suite serves the
// synced-style bundle built from every workspace plugin: doompi-user-feedback
// declares the prompt that stands in for the composer input.
test.use({ assets: 'synced' });

const QUESTIONS = [
  {
    question: 'Which styling approach?',
    header: 'style',
    options: [
      { label: 'Shared components', description: 'reuses the cockpit primitives', preview: '# a preview' },
      { label: 'Bespoke CSS', description: 'drifts from the theme' },
    ],
  },
  {
    question: 'Which tests?',
    header: 'tests',
    multiSelect: true,
    options: [
      { label: 'Unit', description: 'fast' },
      { label: 'Browser', description: 'slow but real' },
    ],
  },
  {
    question: 'When should this ship?',
    header: 'timing',
    options: [
      { label: 'This week', description: 'behind a flag' },
      { label: 'Next release', description: 'with the docs' },
    ],
  },
];

/** Starts the tool and opens the request its first question would open. */
function ask(session: FakeSession): void {
  session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-ask',
    toolName: 'ask_user_question',
    args: { questions: QUESTIONS },
  });
  session.emit({
    type: 'extension_ui_request',
    id: 'req-ask',
    method: 'select',
    title: 'Which styling approach?',
    options: ['Shared components', 'Bespoke CSS', 'Type something.'],
  });
}

test('the questionnaire replaces the composer input and answers every question at once', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  ask(cockpit.session);

  // The input is gone, the modal never opened, and the questionnaire is here.
  await expect(page.getByTestId('questionnaire')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeHidden();
  await expect(page.getByTestId('dialog')).toBeHidden();

  // Both steps show, with only the first one current.
  await expect(page.getByTestId('questionnaire-step-0')).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByTestId('questionnaire-step-1')).toHaveAttribute('data-step-state', 'pending');

  // The descriptions and the preview the select request could never carry.
  await expect(page.getByTestId('questionnaire-option-0')).toContainText('reuses the cockpit primitives');
  await expect(page.getByTestId('questionnaire-preview')).toContainText('a preview');

  // Nothing is submittable until every question is answered.
  await expect(page.getByTestId('questionnaire-submit')).toBeDisabled();

  await page.getByTestId('questionnaire-option-0').click();
  // Answering advances to the step still open.
  await expect(page.getByTestId('questionnaire-step-0')).toHaveAttribute('data-step-state', 'answered');
  await expect(page.getByTestId('questionnaire-step-1')).toHaveAttribute('data-step-state', 'current');

  // Multi-select takes both in one step rather than a round trip per toggle.
  await page.getByTestId('questionnaire-option-0').click();
  await page.getByTestId('questionnaire-option-1').click();
  await page.getByTestId('questionnaire-notes').fill('run the slow ones nightly');
  // A multi-select step does not move on by itself, so both options land on it.
  await expect(page.getByTestId('questionnaire-step-1')).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByTestId('questionnaire-submit')).toBeDisabled();

  await page.getByTestId('questionnaire-step-2').click();
  await page.getByTestId('questionnaire-option-0').click();
  await expect(page.getByTestId('questionnaire-submit')).toBeEnabled();

  await page.getByTestId('questionnaire-submit').click();

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-ask');
  const encoded = answer.value as string;
  expect(encoded.startsWith('doom-ask-user/v1:')).toBe(true);
  expect(JSON.parse(encoded.slice('doom-ask-user/v1:'.length))).toEqual({
    answers: [
      { questionIndex: 0, question: 'Which styling approach?', kind: 'option', answer: 'Shared components' },
      {
        questionIndex: 1,
        question: 'Which tests?',
        kind: 'multi',
        answer: null,
        selected: ['Unit', 'Browser'],
        notes: 'run the slow ones nightly',
      },
      { questionIndex: 2, question: 'When should this ship?', kind: 'option', answer: 'This week' },
    ],
  });

  // The agent is unblocked, so the composer is the composer again.
  cockpit.session.emit({ type: 'extension_ui_answered', id: 'req-ask' });
  cockpit.session.emit({ type: 'tool_execution_end', toolCallId: 'call-ask', result: { content: [] } });
  await expect(page.getByTestId('questionnaire')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('host abort stays available while the questionnaire owns the composer', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({ type: 'agent_start' });
  ask(cockpit.session);

  await expect(page.getByTestId('questionnaire')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeHidden();
  await expect(page.getByTestId('composer-abort')).toBeVisible();

  const commandOffset = cockpit.session.received.length;
  await page.getByTestId('composer-abort').click();
  await cockpit.session.waitForCommand('clear_queue');
  await cockpit.session.waitForCommand('abort');
  expect(
    cockpit.session.received
      .slice(commandOffset)
      .map((frame) => frame.type)
      .filter((type) => type === 'clear_queue' || type === 'abort'),
  ).toEqual(['clear_queue', 'abort']);

  cockpit.session.emit({ type: 'tool_execution_end', toolCallId: 'call-ask', result: { content: [] } });
  cockpit.session.emit({ type: 'agent_settled' });

  await expect(page.getByTestId('questionnaire')).toBeHidden();
  await expect(page.getByTestId('dialog')).toBeHidden();
  await expect(page.getByTestId('composer-abort')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('a step already answered can be reopened and changed before anything is sent', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  ask(cockpit.session);

  await page.getByTestId('questionnaire-option-0').click();

  // Back to the first step: what was chosen there is still chosen.
  await page.getByTestId('questionnaire-step-0').click();
  await expect(page.getByTestId('questionnaire-question')).toHaveText('Which styling approach?');
  await expect(page.getByTestId('questionnaire-option-0')).toHaveAttribute('data-chosen', 'true');

  await page.getByTestId('questionnaire-option-1').click();
  await page.getByTestId('questionnaire-step-0').click();
  await expect(page.getByTestId('questionnaire-option-1')).toHaveAttribute('data-chosen', 'true');
  await expect(page.getByTestId('questionnaire-option-0')).toHaveAttribute('data-chosen', 'false');

  // Finish the two steps still open, so the set can be sent at all.
  await page.getByTestId('questionnaire-step-1').click();
  await page.getByTestId('questionnaire-option-0').click();
  await page.getByTestId('questionnaire-step-2').click();
  await page.getByTestId('questionnaire-option-0').click();
  await page.getByTestId('questionnaire-submit').click();
  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.value as string).toContain('Bespoke CSS');
  expect(answer.value as string).not.toContain('Shared components');
});

test('the reader can decline, and the input comes back either way', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  ask(cockpit.session);
  await expect(page.getByTestId('composer-input')).toBeHidden();

  await page.getByTestId('questionnaire-cancel').click();

  const answer = await cockpit.session.waitForCommand('extension_ui_response');
  expect(answer.id).toBe('req-ask');
  expect(answer.cancelled).toBe(true);

  // The request is settled, so the composer is the composer again.
  cockpit.session.emit({ type: 'extension_ui_answered', id: 'req-ask' });
  cockpit.session.emit({ type: 'tool_execution_end', toolCallId: 'call-ask', result: { content: [] } });
  await expect(page.getByTestId('questionnaire')).toBeHidden();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('the questionnaire stays inside a phone viewport', async ({ page, cockpit }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  ask(cockpit.session);

  const questionnaire = page.getByTestId('questionnaire');
  await expect(questionnaire).toBeVisible();
  await expect(page.getByTestId('questionnaire-question')).toHaveText('Which styling approach?');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const box = await questionnaire.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});

test('a request from anything but this tool still opens the host dialog', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-ask',
    toolName: 'ask_user_question',
    args: { questions: QUESTIONS },
  });
  // Some other extension asks something while the questionnaire tool runs. The
  // title matches no question, so the prompt refuses it.
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'req-other',
    method: 'confirm',
    title: 'permission required',
    message: 'pi wants to write outside the workspace',
  });

  await expect(page.getByTestId('dialog')).toBeVisible();
  await expect(page.getByTestId('questionnaire')).toBeHidden();
});
