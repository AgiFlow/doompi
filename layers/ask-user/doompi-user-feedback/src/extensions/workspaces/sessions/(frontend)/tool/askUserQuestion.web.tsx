import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { AskUserQuestionToolMessage } from './_components/AskUserQuestionToolMessage';
import { QuestionnairePrompt } from './_components/QuestionnairePrompt';
import { readPromptQuestions } from './_lib/questionnaireDraft';

export default defineToolRenderer({
  message: AskUserQuestionToolMessage,
  prompt: {
    claims: (dialog, args) =>
      dialog.method === 'select' &&
      readPromptQuestions(args).some((question) => dialog.title.startsWith(question.question)),
    component: QuestionnairePrompt,
  },
});
