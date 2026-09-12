import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { QuestionParams } from '../../schemas/questionnaire';
import { runQuestionnaire, type QuestionnaireInteraction } from '../questionnaireService';
import type { QuestionnaireResult } from '../../types/questionnaire';

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
