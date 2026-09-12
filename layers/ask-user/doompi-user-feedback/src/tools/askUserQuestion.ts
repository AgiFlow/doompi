import {
  type AskUserBlockedEvent,
  type AskUserPromptEvent,
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-core/ask-user';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type QuestionParams, QuestionParamsSchema } from '../schemas/questionnaire';
import type { QuestionnaireRunner } from '../services/questionnaireCoordinator';
import { buildQuestionnaireResponse, buildToolResult } from '../services/responseService';
import { validateQuestionnaire } from '../services/validationService';
import type { QuestionnaireResult } from '../types/questionnaire';
import { loadUserFeedbackConfig, resolveCollapseKey } from '../services/config';
import { buildVoiceToolResult } from '../services/voiceQuestionHandoff';
import { runRpcQuestionnaire } from '../services/rpcQuestionnaire';

import {
  ASK_USER_QUESTION_TOOL_NAME,
  DEFAULT_PROMPT_SNIPPET,
  DEFAULT_PROMPT_GUIDELINES,
  ERROR_NO_UI,
  ERROR_NO_CUSTOM_UI,
  ERROR_SESSION_LOAD_FAILED,
  ERROR_SESSION_INACTIVE,
} from '../constants/tool';
export interface AskUserQuestionToolDependencies {
  enqueue: (runner: QuestionnaireRunner, signal?: AbortSignal) => Promise<QuestionnaireResult>;
  isActive?: (context: ExtensionContext, signal?: AbortSignal) => boolean;
  tryVoice?: (params: QuestionParams) => QuestionnaireResult | undefined | Promise<QuestionnaireResult | undefined>;
  runTui: (
    context: ExtensionContext,
    params: QuestionParams,
    collapseKey: string,
    signal?: AbortSignal,
    reportProgress?: (result: QuestionnaireResult) => void,
  ) => Promise<QuestionnaireResult | undefined>;
}

function emitPrompt(cordis: Context, params: QuestionParams): void {
  const payload: AskUserPromptEvent = {
    questions: params.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect ?? false,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
        hasPreview: Boolean(option.preview),
      })),
    })),
  };
  cordis.emit(DOOM_ASK_USER_PROMPT_EVENT, payload);
}

function emitBlocked(cordis: Context, active: boolean): void {
  const payload: AskUserBlockedEvent = { active };
  cordis.emit(DOOM_ASK_USER_BLOCKED_EVENT, payload);
}

function hasDialogUI(context: ExtensionContext): boolean {
  const ui = context.ui as unknown as { select?: unknown; input?: unknown };
  return typeof ui.select === 'function' && typeof ui.input === 'function';
}

export function createAskUserQuestionTool(
  cordis: Context,
  dependencies: AskUserQuestionToolDependencies,
  renderers: Pick<ToolDefinition<typeof QuestionParamsSchema, QuestionnaireResult>, 'renderCall' | 'renderResult'> = {},
): ToolDefinition<typeof QuestionParamsSchema, QuestionnaireResult> {
  const configuredGuidance = loadUserFeedbackConfig().guidance;
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    renderShell: 'self',
    description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself, reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid.
- If you recommend a specific option, make that the first option and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional preview field for ASCII mockups, code snippets, diagrams, or configuration examples that users should compare visually. Do not use previews for simple preference questions.`,
    promptSnippet: configuredGuidance?.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: configuredGuidance?.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
    parameters: QuestionParamsSchema,
    executionMode: 'sequential',

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const typed = params as QuestionParams;
      const isActive = (activeSignal?: AbortSignal): boolean => dependencies.isActive?.(context, activeSignal) ?? true;
      const cancelled = (): QuestionnaireResult => ({ answers: [], cancelled: true });
      if (!isActive(signal)) return buildToolResult(ERROR_SESSION_INACTIVE, cancelled());
      if (!context.hasUI) {
        return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: 'no_ui' });
      }

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return buildToolResult(validation.message, {
          answers: [],
          cancelled: true,
          error: validation.error,
        });
      }

      try {
        const result = await dependencies.enqueue(async ({ signal: activeSignal, reportProgress }) => {
          if (!isActive(activeSignal)) return cancelled();
          emitPrompt(cordis, typed);
          const voiceResult = await dependencies.tryVoice?.(typed);
          if (voiceResult) return voiceResult;

          let blocked = true;
          const clearBlocked = (): void => {
            if (!blocked) return;
            blocked = false;
            if (isActive()) emitBlocked(cordis, false);
          };
          activeSignal.addEventListener('abort', clearBlocked, { once: true });
          emitBlocked(cordis, true);
          try {
            if (!isActive(activeSignal)) return cancelled();
            if (context.mode === 'rpc' && hasDialogUI(context)) {
              const rpcResult = await runRpcQuestionnaire(context, typed, activeSignal, reportProgress);
              return isActive(activeSignal) ? rpcResult : cancelled();
            }

            const tuiResult = await dependencies.runTui(
              context,
              typed,
              resolveCollapseKey(loadUserFeedbackConfig()),
              activeSignal,
              reportProgress,
            );
            if (!isActive(activeSignal)) return cancelled();
            if (tuiResult !== undefined) return tuiResult;
            if (hasDialogUI(context)) {
              const rpcResult = await runRpcQuestionnaire(context, typed, activeSignal, reportProgress);
              return isActive(activeSignal) ? rpcResult : cancelled();
            }
            return { answers: [], cancelled: true, error: 'no_custom_ui' };
          } finally {
            activeSignal.removeEventListener('abort', clearBlocked);
            clearBlocked();
          }
        }, signal);

        if (result.delivery === 'voice') return buildVoiceToolResult(result);
        if (result.error === 'no_custom_ui') return buildToolResult(ERROR_NO_CUSTOM_UI, result);
        return buildQuestionnaireResponse(result, typed);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return buildToolResult(`${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})`, {
          answers: [],
          cancelled: true,
          error: 'session_load_failed',
        });
      }
    },

    ...renderers,
  };
}
