import {
  MAX_NARRATION_TEXT_CHARACTERS,
  NarrationRequestSchema,
  normalizeNarrationText,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  VOICE_NARRATE_TOOL_NAME,
  type VoiceToolErrorPayload,
  type VoiceToolSessionHandle,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { NarrationPlaybackOutcome } from '../../services/narration.ts';
import type { VoiceWorkerAutoCaptureController } from '../process/voiceWorkerAutoCaptureController.ts';
import { renderNarrationToolCall, renderNarrationToolResult } from './voiceToolRender.ts';
import type { VoiceToolReadinessWaiter } from './voiceTools.ts';

const NARRATE_LABEL = 'Narrate';
const NARRATE_DESCRIPTION =
  'Speak one concise primary-agent-authored update through the active autonomous Voice session and wait until physical playback settles.';
const NARRATE_PROMPT_GUIDELINES = [
  'When the user asks for work, acknowledge the request with a brief narration before using tools or starting the work. Say what you are about to do, not the full plan.',
  'During non-trivial work, narrate a meaningful finding, blocker, risk, or change in plan or direction. State why it matters and what you will do next so the user can follow progress.',
  'Do not narrate routine commands, repeated low-level progress, internal reasoning, or the same update more than once.',
  'Before every user-facing final response, narrate a concise, action-focused summary. Include the outcome, any material warning or unresolved question, and the next action when one exists; leave supporting detail in text.',
  'For a short conversational, clarification, refusal, or error turn, one narration that speaks the concise response is enough.',
  'Only a narrate call produces speech; ordinary response text and visible status or progress prose are not narration.',
  'Use narrate with one complete utterance per call, ready to speak verbatim. Never split one utterance across calls or request another summarization pass.',
  'Keep narration within the 4,096-character limit. Use concise plain language. Avoid Markdown, code, secrets, and raw paths.',
  'Wait for each narrate result. Treat interrupted, superseded, or failed playback as terminal for that utterance; do not automatically repeat it.',
] as const;

export type NarrationToolProgress = 'playing';
export type NarrationToolOutcome = NarrationPlaybackOutcome;

export interface NarrationToolDetails {
  outcome: NarrationToolProgress | NarrationToolOutcome;
  error?: VoiceToolErrorPayload;
}

export interface NarrationToolRuntime {
  readonly context: ExtensionContext;
  readonly session: VoiceToolSessionHandle<ExtensionContext>;
  readonly controller: Pick<VoiceWorkerAutoCaptureController, 'state' | 'narrateAgent'>;
}

export type NarrationToolRuntimeProvider = () => NarrationToolRuntime | undefined;

type NarrationTool = ToolDefinition<typeof NarrationRequestSchema, NarrationToolDetails>;

function textResult(text: string, details: NarrationToolDetails): AgentToolResult<NarrationToolDetails> {
  return { content: [{ type: 'text', text }], details };
}

function failure(code: VoiceToolErrorPayload['code'], message: string): AgentToolResult<NarrationToolDetails> {
  return textResult(message, { outcome: 'failed', error: { code, message, retryable: true } });
}

function contextSessionId(context: ExtensionContext): string | undefined {
  const sessionManager = context.sessionManager as { getSessionId?: () => string } | undefined;
  return sessionManager?.getSessionId?.();
}

export function isNarrationRuntimeActive(
  runtime: NarrationToolRuntime | undefined,
  context: ExtensionContext,
): runtime is NarrationToolRuntime {
  if (context.hasUI !== true || !runtime) return false;
  const executionSessionId = contextSessionId(context);
  const boundSessionId = contextSessionId(runtime.context);
  return (
    executionSessionId !== undefined &&
    executionSessionId === runtime.session.sessionId &&
    boundSessionId === runtime.session.sessionId &&
    runtime.context.sessionManager === context.sessionManager &&
    runtime.context.hasUI === true &&
    runtime.session.active &&
    runtime.controller.state === 'active'
  );
}

function runtimeError(
  runtime: NarrationToolRuntime | undefined,
  context: ExtensionContext,
): AgentToolResult<NarrationToolDetails> | undefined {
  if (context.hasUI !== true) {
    return failure('VOICE_TOOL_HOST_UNAVAILABLE', 'Narration needs a session that can show its Voice indicator.');
  }
  if (!runtime) {
    return failure('VOICE_TOOL_HOST_UNAVAILABLE', 'Narration is not bound to an autonomous Voice session.');
  }
  const executionSessionId = contextSessionId(context);
  const boundSessionId = contextSessionId(runtime.context);
  if (
    !executionSessionId ||
    executionSessionId !== runtime.session.sessionId ||
    boundSessionId !== runtime.session.sessionId ||
    runtime.context.sessionManager !== context.sessionManager ||
    runtime.context.hasUI !== true
  ) {
    return failure('VOICE_TOOL_STALE_SESSION', 'The narration request belongs to a stale Voice session.');
  }
  if (!runtime.session.active || runtime.controller.state !== 'active') {
    return failure('VOICE_TOOL_INACTIVE', 'Autonomous Voice narration is not active.');
  }
  return undefined;
}

export function createNarrationTool(
  runtimeProvider: NarrationToolRuntimeProvider,
  waitUntilReady?: VoiceToolReadinessWaiter,
): NarrationTool {
  return {
    name: VOICE_NARRATE_TOOL_NAME,
    label: NARRATE_LABEL,
    description: NARRATE_DESCRIPTION,
    promptGuidelines: [...NARRATE_PROMPT_GUIDELINES],
    parameters: NarrationRequestSchema,
    executionMode: 'sequential',
    renderShell: 'self',
    renderCall(args, theme) {
      return renderNarrationToolCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderNarrationToolResult(context.args, result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<NarrationToolDetails> | undefined,
      context: ExtensionContext,
    ): Promise<AgentToolResult<NarrationToolDetails>> {
      try {
        await waitUntilReady?.(context, signal);
      } catch (error) {
        return failure(
          'VOICE_TOOL_HOST_UNAVAILABLE',
          error instanceof Error ? error.message : 'Voice configuration initialization failed.',
        );
      }
      const runtime = runtimeProvider();
      const unavailable = runtimeError(runtime, context);
      if (unavailable || !runtime)
        return unavailable ?? failure('VOICE_TOOL_HOST_UNAVAILABLE', 'Narration unavailable.');
      if (params.text.length > MAX_NARRATION_TEXT_CHARACTERS) {
        return failure('VOICE_TOOL_INVALID_INPUT', 'Narration exceeds the 4,096-character limit.');
      }
      const text = normalizeNarrationText(params.text);
      if (!text) return failure('VOICE_TOOL_INVALID_INPUT', 'Narration text must not be empty.');

      onUpdate?.(textResult('Narration is playing.', { outcome: 'playing' }));
      const outcome = await runtime.controller.narrateAgent(text, signal);
      if (runtimeProvider() !== runtime || runtimeError(runtime, context)) {
        return textResult('Narration was interrupted because the Voice session changed.', { outcome: 'interrupted' });
      }
      return textResult(`Narration ${outcome}.`, { outcome });
    },
  };
}

export function registerNarrationTool(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  runtimeProvider: NarrationToolRuntimeProvider,
  waitUntilReady?: VoiceToolReadinessWaiter,
): void {
  pi.registerTool(createNarrationTool(runtimeProvider, waitUntilReady));
}
