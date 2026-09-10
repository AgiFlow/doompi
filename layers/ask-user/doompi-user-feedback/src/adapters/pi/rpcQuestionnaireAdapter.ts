import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { QuestionParams } from '../../schemas/questionnaire.js';
import { runQuestionnaire, type QuestionnaireInteraction } from '../../services/questionnaireService.js';
import type { QuestionnaireResult } from '../../types/questionnaire.js';

export async function runRpcQuestionnaire(
  context: ExtensionContext,
  params: QuestionParams,
  signal?: AbortSignal,
  reportProgress?: (result: QuestionnaireResult) => void,
): Promise<QuestionnaireResult> {
  const interaction: QuestionnaireInteraction = {
    select: (title, options, interactionSignal) =>
      context.ui.select(title, [...options], { signal: interactionSignal }),
    input: (title, placeholder, interactionSignal) =>
      context.ui.input(title, placeholder, { signal: interactionSignal }),
  };
  return runQuestionnaire(interaction, params, signal, reportProgress);
}
