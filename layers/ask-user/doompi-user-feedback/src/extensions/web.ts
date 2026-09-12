import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { AskUserQuestionToolMessage } from '../web/components/AskUserQuestionToolMessage';
import { QuestionnairePrompt } from '../web/components/QuestionnairePrompt';
import { readPromptQuestions } from '../web/lib/questionnaireDraft';

/**
 * This package's cockpit presence: the timeline card for ask_user_question,
 * the web half of the TUI's renderCall and renderResult, and the questionnaire
 * itself, which stands in for the composer input while the agent waits.
 *
 * The request carries only the first question's labels, so the prompt claims
 * it by matching the title against the questions the tool was actually called
 * with. Anything else open at the same time belongs to somebody else and keeps
 * the host's dialog.
 */
export const webPlugin = defineWebPlugin({
  id: 'ask-user',
  session: {
    toolRenderers: [
      {
        tools: ['ask_user_question'],
        message: AskUserQuestionToolMessage,
        prompt: {
          claims: (dialog, args) =>
            dialog.method === 'select' &&
            readPromptQuestions(args).some((question) => dialog.title.startsWith(question.question)),
          component: QuestionnairePrompt,
        },
      },
    ],
  },
});
