import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { AskUserQuestionToolMessage } from './AskUserQuestionToolMessage.tsx';

/**
 * This package's cockpit presence: the timeline card for ask_user_question,
 * the web half of the TUI's renderCall and renderResult. The questionnaire
 * itself reaches the cockpit as an extension UI dialog; this card is its
 * record in the transcript.
 */
export const webPlugin = defineWebPlugin({
  id: 'ask-user',
  toolRenderers: [{ tools: ['ask_user_question'], message: AskUserQuestionToolMessage }],
});
