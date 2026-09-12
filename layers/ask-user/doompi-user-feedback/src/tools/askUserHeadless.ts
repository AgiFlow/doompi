import { type DoomHeadlessTool, type DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import type { QuestionParams } from '../schemas/questionnaire';
import { QuestionParamsSchema } from '../schemas/questionnaire';
import { QuestionnaireCoordinator } from '../services/questionnaireCoordinator';
import { runQuestionnaire, type QuestionnaireInteraction } from '../services/questionnaireService';
import { buildQuestionnaireResponse, buildToolResult } from '../services/responseService';
import { validateQuestionnaire } from '../services/validationService';
import type { QuestionnaireResult } from '../types/questionnaire';

import { ASK_USER_QUESTION_TOOL_NAME } from '../constants/tool';

function output(result: {
  content: Array<{ type: 'text'; text: string }>;
  details: QuestionnaireResult;
}): DoomHeadlessToolResult {
  return { content: result.content, details: result.details };
}

export function createAskUserHeadlessTool(
  coordinator: QuestionnaireCoordinator,
): DoomHeadlessTool<typeof QuestionParamsSchema> {
  const tool: DoomHeadlessTool<typeof QuestionParamsSchema> = {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    description: 'Ask the user one or more structured questions during execution.',
    parameters: QuestionParamsSchema,
    promptSnippet: 'Ask the user structured questions when requirements are ambiguous',
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, _onUpdate, executionContext) {
      const params = parameters as QuestionParams;
      const validation = validateQuestionnaire(params);
      if (!validation.ok) {
        return output(buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error }));
      }
      const result = await coordinator.enqueue(async ({ signal: requestSignal, reportProgress }) => {
        requestSignal.throwIfAborted();
        const interaction: QuestionnaireInteraction = {
          select: async (title, options, interactionSignal) => {
            const response = await executionContext.client.request(
              {
                kind: 'select',
                title,
                options: options.map((label) => ({ label, value: label })),
              },
              interactionSignal,
            );
            return typeof response === 'string' ? response : undefined;
          },
          input: async (title, placeholder, interactionSignal) => {
            const response = await executionContext.client.request(
              { kind: 'input', title, message: placeholder },
              interactionSignal,
            );
            return typeof response === 'string' ? response : undefined;
          },
        };
        const questionnaire = await runQuestionnaire(interaction, params, requestSignal, reportProgress);
        requestSignal.throwIfAborted();
        return questionnaire;
      }, signal);
      return output(buildQuestionnaireResponse(result, params));
    },
  };
  return tool;
}
