import {
  VOICE_DESCRIBE_TOOL_NAME,
  VOICE_USE_TOOL_NAME,
  type VoiceToolBatchResult,
  type VoiceToolCatalogSnapshot,
  VoiceToolDescribeInputSchema,
  VoiceToolError,
  type VoiceToolErrorPayload,
  type VoiceToolSessionHandle,
  VoiceToolUseInputSchema,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { formatBatch, formatCatalog, formatCatalogDigest, formatError } from '../../services/voiceToolPrompt.ts';
import { renderVoiceToolCall, renderVoiceToolResult } from './voiceToolRender.ts';

const DESCRIBE_LABEL = 'Describe voice tools';
const USE_LABEL = 'Use voice tools';

/**
 * `use_voice_tools` is static; `describe_voice_tools` carries the capability names.
 *
 * The description was static on both for a while, because rebuilding it from the live
 * catalog on every revision invalidated the prompt cache each time a capability
 * registered. That traded away the only thing that makes the façade discoverable: the
 * contributed names appear nowhere else in pushed context, so a model asked to switch a
 * minor mode has nothing to match on and never calls the tool at all. A protocol-only
 * description describes a door with no sign on it.
 *
 * The cost is bounded rather than paid per revision. `refresh` re-registers only when
 * the rendered digest actually changes, and it excludes the session-scoped token and the
 * per-activation `enabled` flag, which are the two values that would otherwise move
 * constantly. Contributors all register during startup, so the name set reaches a fixed
 * point there and the description is stable for the rest of the session.
 */
const DESCRIBE_PROTOCOL_TEXT =
  'Discover the voice capabilities registered for this session and obtain the catalog token that use_voice_tools requires. Call with no arguments to list capability names and descriptions. Call with names to also read each capability input schema. The token changes whenever the catalog changes.';
const USE_DESCRIPTION =
  'Run registered voice capabilities as one sequential batch. Requires the catalog token from the most recent describe_voice_tools result and one call per capability, each input matching that capability input schema. The whole batch is validated before anything runs, so a rejected batch executes nothing.';

function describeDescription(digest: string | undefined): string {
  return digest ? `${DESCRIBE_PROTOCOL_TEXT}\n\n${digest}` : DESCRIBE_PROTOCOL_TEXT;
}

const DESCRIBE_PROMPT_SNIPPET = 'List the registered autonomous voice capabilities and obtain a catalog token.';
const USE_PROMPT_SNIPPET = 'Run one or more registered autonomous voice capabilities in order.';

const DESCRIBE_PROMPT_GUIDELINES = [
  'Call describe_voice_tools before every use_voice_tools batch. Its catalog_token is the only accepted token, and it changes whenever a capability registers or deregisters and whenever autonomous voice is activated or deactivated.',
  'A bare call lists capability names and descriptions only. Call again with names set to the capabilities you intend to run to read their input_schema, and build each call input from that schema rather than from the description.',
] as const;
const USE_PROMPT_GUIDELINES = [
  'Copy the catalog_token from the most recent describe_voice_tools result verbatim. Never invent one, edit one, or reuse one from an earlier turn.',
  'A VOICE_TOOL_STALE_CATALOG rejection means the catalog moved. Use the fresh catalog_token returned with that rejection, or describe again, before retrying. Do not resend the rejected token.',
  'Every call is preflighted before any of them run, so one invalid input stops the whole batch. Keep a batch to the capabilities the current step actually needs.',
] as const;

const NO_SESSION_ERROR: VoiceToolErrorPayload = {
  code: 'VOICE_TOOL_HOST_UNAVAILABLE',
  message: 'Autonomous voice is not bound to an active Pi session.',
  retryable: true,
};

export interface VoiceToolFacadeRegistration {
  /**
   * Re-publishes `describe_voice_tools` when the capability list has changed.
   *
   * Cheap to call on every catalog revision: re-registration only happens when the
   * rendered digest differs, because `registerTool` rebuilds the whole system prompt.
   */
  refresh(): void;
  /** Drops the façade registration and prevents future use. */
  dispose(): void;
}

export type VoiceToolSessionProvider = () => VoiceToolSessionHandle<ExtensionContext> | undefined;
export type VoiceToolReadinessWaiter = (context: ExtensionContext, signal?: AbortSignal) => Promise<void>;

type DescribeDetails = VoiceToolCatalogSnapshot | { error: VoiceToolErrorPayload };
type UseDetails = VoiceToolBatchResult | { error: VoiceToolErrorPayload };

type DescribeTool = ToolDefinition<typeof VoiceToolDescribeInputSchema, DescribeDetails>;
type UseTool = ToolDefinition<typeof VoiceToolUseInputSchema, UseDetails>;

function errorPayload(error: unknown): VoiceToolErrorPayload {
  if (error instanceof VoiceToolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return { code: 'VOICE_TOOL_EXECUTION_FAILED', message: 'Voice tool façade execution failed.' };
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details };
}

function failureResult<T>(error: unknown): AgentToolResult<T | { error: VoiceToolErrorPayload }> {
  const details = errorPayload(error);
  return textResult(formatError(details), { error: details });
}

function operationIdFor(toolCallId: string): string | undefined {
  const normalized = toolCallId.trim();
  if (!normalized || normalized.length > 128) return undefined;
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return undefined;
  }
  return normalized;
}

function currentContextMatchesSession(
  context: ExtensionContext,
  session: VoiceToolSessionHandle<ExtensionContext>,
): boolean {
  const sessionManager = context.sessionManager as { getSessionId?: () => string } | undefined;
  return sessionManager?.getSessionId?.() === session.sessionId;
}

function createDescribeTool(
  sessionProvider: VoiceToolSessionProvider,
  waitUntilReady: VoiceToolReadinessWaiter | undefined,
  digest: string | undefined,
): DescribeTool {
  return {
    name: VOICE_DESCRIBE_TOOL_NAME,
    label: DESCRIBE_LABEL,
    description: describeDescription(digest),
    promptSnippet: DESCRIBE_PROMPT_SNIPPET,
    promptGuidelines: [...DESCRIBE_PROMPT_GUIDELINES],
    parameters: VoiceToolDescribeInputSchema,
    executionMode: 'sequential',
    renderShell: 'self',
    renderCall(args, theme) {
      return renderVoiceToolCall(VOICE_DESCRIBE_TOOL_NAME, args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderVoiceToolResult(VOICE_DESCRIBE_TOOL_NAME, context.args, result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<DescribeDetails> | undefined,
      context: ExtensionContext,
    ): Promise<AgentToolResult<DescribeDetails>> {
      try {
        await waitUntilReady?.(context, signal);
        const session = sessionProvider();
        if (!session || !currentContextMatchesSession(context, session)) {
          return textResult(formatError(NO_SESSION_ERROR), { error: NO_SESSION_ERROR });
        }
        const snapshot = session.describe(params);
        // Naming capabilities is what asks for their schemas; a bare call stays cheap.
        return textResult(formatCatalog(snapshot, params.names !== undefined), snapshot);
      } catch (error) {
        return failureResult(error);
      }
    },
  };
}

function createUseTool(sessionProvider: VoiceToolSessionProvider, waitUntilReady?: VoiceToolReadinessWaiter): UseTool {
  return {
    name: VOICE_USE_TOOL_NAME,
    label: USE_LABEL,
    description: USE_DESCRIPTION,
    promptSnippet: USE_PROMPT_SNIPPET,
    promptGuidelines: [...USE_PROMPT_GUIDELINES],
    parameters: VoiceToolUseInputSchema,
    executionMode: 'sequential',
    renderShell: 'self',
    renderCall(args, theme) {
      return renderVoiceToolCall(VOICE_USE_TOOL_NAME, args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderVoiceToolResult(VOICE_USE_TOOL_NAME, context.args, result, options, theme);
    },
    async execute(
      toolCallId: string,
      params,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<UseDetails> | undefined,
      context: ExtensionContext,
    ): Promise<AgentToolResult<UseDetails>> {
      try {
        await waitUntilReady?.(context, signal);
        const session = sessionProvider();
        if (!session || !currentContextMatchesSession(context, session)) {
          return textResult(formatError(NO_SESSION_ERROR), { error: NO_SESSION_ERROR });
        }
        const operationId = operationIdFor(toolCallId);
        const result = await session.executeBatch(params, context, {
          ...(signal ? { signal } : {}),
          ...(operationId ? { operationId } : {}),
        });
        // The batch carries every call result and a fresh token, both of which the model
        // needs and neither of which reaches it through `details`.
        return textResult(formatBatch(result), result);
      } catch (error) {
        return failureResult(error);
      }
    },
  };
}

export function registerVoiceToolFacades(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  sessionProvider: VoiceToolSessionProvider,
  waitUntilReady?: VoiceToolReadinessWaiter,
): VoiceToolFacadeRegistration {
  let disposed = false;
  let digest: string | undefined;
  const live: VoiceToolSessionProvider = () => (disposed ? undefined : sessionProvider());
  pi.registerTool(createDescribeTool(live, waitUntilReady, digest));
  pi.registerTool(createUseTool(live, waitUntilReady));
  return {
    refresh() {
      if (disposed) return;
      // A bare describe: the digest carries names and descriptions, never schemas.
      const next = formatCatalogDigest(sessionProvider()?.describe().tools ?? []);
      if (next === digest) return;
      digest = next;
      pi.registerTool(createDescribeTool(live, waitUntilReady, digest));
    },
    dispose() {
      disposed = true;
    },
  };
}
