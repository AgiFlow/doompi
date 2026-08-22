import {
  type AskUserBlockedEvent,
  type AskUserPromptEvent,
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-extension-contracts/ask-user';
import { DoomToolCall, DoomToolResult, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionParams,
  QuestionParamsSchema,
} from '../../schemas/questionnaire.js';
import type { QuestionnaireRunner } from '../../services/questionnaireCoordinator.js';
import { buildQuestionnaireResponse, buildToolResult } from '../../services/responseService.js';
import { validateQuestionnaire } from '../../services/validationService.js';
import type { QuestionnaireResult } from '../../types/questionnaire.js';
import { loadUserFeedbackConfig, resolveCollapseKey } from '../config/configAdapter.js';
import { buildVoiceToolResult } from '../doom/voiceQuestionHandoff.js';
import { runRpcQuestionnaire } from './rpcQuestionnaireAdapter.js';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES = [
  `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
  `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
  'Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.',
  'Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.',
];

const ERROR_NO_UI = 'Error: UI not available (running in non-interactive mode)';
const ERROR_NO_CUSTOM_UI =
  'Error: this client cannot render the questionnaire (custom UI is unavailable). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.';
const ERROR_SESSION_LOAD_FAILED =
  'Error: the questionnaire UI failed to load. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.';
const ERROR_SESSION_INACTIVE = 'Error: the questionnaire session is no longer active.';

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

export function registerAskUserQuestionTool(
  pi: ExtensionAPI,
  cordis: Context,
  dependencies: AskUserQuestionToolDependencies,
): void {
  const configuredGuidance = loadUserFeedbackConfig().guidance;
  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    renderShell: 'self',
    description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
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

    renderCall(args, theme) {
      const params = args as QuestionParams;
      const headers = params.questions.map((question) => question.header).join(', ');
      const count = `${params.questions.length} question${params.questions.length === 1 ? '' : 's'}`;
      const heading = renderToolHeading('ask', count, theme);
      return new DoomToolCall(headers ? `${heading} ${theme.fg('dim', `(${headers})`)}` : heading);
    },

    renderResult(result, _options, theme, context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const raw = result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        const color = context.isError ? 'error' : 'toolOutput';
        const fallback = context.isError ? '✗ failed' : '✓ submitted';
        return new DoomToolResult([theme.fg(color, raw || fallback)], theme, { wrap: true });
      }
      if (details.cancelled) {
        return new DoomToolResult([theme.fg('warning', '◐') + theme.fg('dim', ' cancelled')], theme);
      }
      if (details.delivery === 'voice' && details.voicePrompt) {
        return new DoomToolResult([theme.fg('toolOutput', details.voicePrompt)], theme, { wrap: true });
      }
      const lines = details.answers.map((answer) => {
        const scalar = answer.kind === 'multi' ? (answer.selected ?? []).join(', ') : answer.answer;
        return `${theme.fg('success', '✓')} ${theme.fg('accent', answer.question)}: ${theme.fg(
          'toolOutput',
          scalar ?? '',
        )}`;
      });
      if (lines.length === 0) lines.push(theme.fg('success', '✓') + theme.fg('dim', ' submitted'));
      return new DoomToolResult(lines, theme, { wrap: true });
    },
  });
}
