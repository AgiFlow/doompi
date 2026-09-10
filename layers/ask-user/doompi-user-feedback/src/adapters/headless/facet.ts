import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import type { QuestionParams } from '../../schemas/questionnaire.ts';
import { QuestionParamsSchema } from '../../schemas/questionnaire.ts';
import { QuestionnaireCoordinator } from '../../services/questionnaireCoordinator.ts';
import { runQuestionnaire, type QuestionnaireInteraction } from '../../services/questionnaireService.ts';
import { buildQuestionnaireResponse, buildToolResult } from '../../services/responseService.ts';
import { validateQuestionnaire } from '../../services/validationService.ts';
import type { QuestionnaireResult } from '../../types/questionnaire.ts';

const TOOL_NAME = 'ask_user_question';

function output(result: {
  content: Array<{ type: 'text'; text: string }>;
  details: QuestionnaireResult;
}): DoomHeadlessToolResult {
  return { content: result.content, details: result.details };
}

export const userFeedbackHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const coordinator = new QuestionnaireCoordinator();
    const tool: DoomHeadlessTool<typeof QuestionParamsSchema> = {
      name: TOOL_NAME,
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
    const shutdown = host.registerHook({ event: 'session_shutdown', handle: () => coordinator.shutdown() });
    const registration = host.registerTool(tool);
    return () => {
      shutdown.dispose();
      registration.dispose();
      coordinator.shutdown();
    };
  },
};

export default userFeedbackHeadlessFacet;
