import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { AskUserQuestionToolMessage } from '../../../../../web/components/AskUserQuestionToolMessage';
import { QuestionnairePrompt } from '../../../../../web/components/QuestionnairePrompt';
import { readPromptQuestions } from '../../../../../web/lib/questionnaireDraft';

export default defineToolRenderer({
  message: AskUserQuestionToolMessage,
  prompt: {
    claims: (dialog, args) =>
      dialog.method === 'select' &&
      readPromptQuestions(args).some((question) => dialog.title.startsWith(question.question)),
    component: QuestionnairePrompt,
  },
});
