import type { PiEventHandlers } from '@agimon-ai/doompi-core/piExtension';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  STATUS_PREFIX,
  FAILURE_MESSAGE_TYPE,
  CONTEXT_MESSAGE_TYPE,
  STOP_BLOCK_MESSAGE_TYPE,
  FOLLOW_UP_TURN,
  MAX_STOP_REFUSALS,
  NO_TURN,
  STEER,
  STOP_HOOK_ACTIVE_FIELD,
  SUBAGENT_ENVIRONMENT_FLAG,
  CONTEXT_SEPARATOR,
} from '../../constants/hookHandlers';
import { HOOK_EVENT } from '../../constants/hooks';
import type { HookFailure } from '../../types/hooks';
import { additionalContextsFrom, decisionReason, hookFailureMessage, isDenied } from '../hookDecisions';
import { dispatchHooks } from '../hookDispatch';
import type { HookDispatchRequest, HookDispatchResult, HookDispatchScope } from '../hookDispatch/type';
import type { HookRuntimeResolver, HookSession } from '../hookRuntime/type';

function scopeFor(pi: ExtensionAPI, session: HookSession, ctx: ExtensionContext): HookDispatchScope {
  if (session.parentContext) return { ...session.parentContext, signal: session.signal, operationSignal: ctx.signal };
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    isSubagent: Boolean(process.env[SUBAGENT_ENVIRONMENT_FLAG]),
    cwd: ctx.cwd,
    repoRoot: session.config().harness.root ?? ctx.cwd,
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
    signal: session.signal,
    operationSignal: ctx.signal,
    async sendMessage(text, delivery) {
      pi.sendMessage({ customType: CONTEXT_MESSAGE_TYPE, content: text, display: true }, { deliverAs: delivery });
    },
    async appendCustomEntry(type, data) {
      pi.appendEntry(type, data);
    },
  };
}

async function runPiDispatch(
  pi: ExtensionAPI,
  session: HookSession,
  ctx: ExtensionContext,
  request: HookDispatchRequest,
  statusKey: string,
  statusLabel: string,
  signal?: AbortSignal,
): Promise<HookDispatchResult> {
  try {
    const scope = scopeFor(pi, session, ctx);
    return await dispatchHooks(
      session,
      { ...scope, operationSignal: signal ?? scope.operationSignal },
      {
        ...request,
        progress: (index, total) => {
          if (ctx.hasUI) ctx.ui.setStatus(statusKey, `${statusLabel} (${index + 1}/${total})...`);
        },
      },
    );
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
  }
}

async function steerHookFailures(
  pi: ExtensionAPI,
  session: HookSession,
  failures: ReadonlyArray<HookFailure>,
): Promise<void> {
  if (failures.length === 0) return;
  if (session.parentContext) await session.parentContext.sendMessage(hookFailureMessage(failures), 'steer');
  else
    pi.sendMessage({ customType: FAILURE_MESSAGE_TYPE, content: hookFailureMessage(failures), display: true }, STEER);
}

function createSessionStart(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): PiEventHandlers['session_start'] {
  return (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent() || scopeFor(pi, runtime.session, ctx).isSubagent) return undefined;
    const { session, readiness } = runtime;
    const run = async (signal?: AbortSignal, isReady: () => boolean = () => true): Promise<void> => {
      await session.prepare();
      const result = await runPiDispatch(
        pi,
        session,
        ctx,
        { eventName: HOOK_EVENT.sessionStart, event },
        `${STATUS_PREFIX}:${ctx.sessionManager.getSessionId()}:start`,
        'Running session-start hooks',
        signal,
      );
      signal?.throwIfAborted();
      if (!runtime.isCurrent() || !isReady()) return;
      await steerHookFailures(pi, session, result.failures);
      const context = additionalContextsFrom(result.decisions).join(CONTEXT_SEPARATOR);
      if (context) await scopeFor(pi, session, ctx).sendMessage(context, 'steer');
    };
    return readiness ? readiness.start(ctx, run) : run();
  };
}

function createBeforeAgentStart(resolveRuntime: HookRuntimeResolver): PiEventHandlers['before_agent_start'] {
  return async (_event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return;
    await runtime.session.prepare(
      runtime.session.parentContext?.isSubagent ?? Boolean(process.env[SUBAGENT_ENVIRONMENT_FLAG]),
    );
    await runtime.readiness?.wait(ctx);
  };
}

function createToolCall(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): PiEventHandlers['tool_call'] {
  return async (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return undefined;
    // Readiness is a host gate, not an advisory hook error.
    try {
      await runtime.session.prepare(scopeFor(pi, runtime.session, ctx).isSubagent);
      await runtime.readiness?.wait(ctx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        pi.sendMessage({ customType: FAILURE_MESSAGE_TYPE, content: reason, display: true }, STEER);
      } catch {
        // The tool block still carries recovery when prompt admission is unavailable.
      }
      return { block: true, reason };
    }
    if (!runtime.isCurrent()) return undefined;
    const result = await runPiDispatch(
      pi,
      runtime.session,
      ctx,
      { eventName: HOOK_EVENT.preToolUse, event },
      `${STATUS_PREFIX}:${event.toolCallId}:pre`,
      `Running pre-tool hooks for ${event.toolName}`,
    );
    if (!runtime.isCurrent()) return undefined;
    await steerHookFailures(pi, runtime.session, result.failures);
    return result.toolCall;
  };
}

function createToolResult(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): PiEventHandlers['tool_result'] {
  return async (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return undefined;
    await runtime.readiness?.wait(ctx);
    if (!runtime.isCurrent()) return undefined;
    const result = await runPiDispatch(
      pi,
      runtime.session,
      ctx,
      { eventName: HOOK_EVENT.postToolUse, event },
      `${STATUS_PREFIX}:${event.toolCallId}:post`,
      `Running post-tool hooks for ${event.toolName}`,
    );
    if (!runtime.isCurrent()) return undefined;
    return result.toolResult;
  };
}

function createAgentSettled(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): PiEventHandlers['agent_settled'] {
  let refusals = 0;
  return async (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent() || scopeFor(pi, runtime.session, ctx).isSubagent) return;
    await runtime.readiness?.wait(ctx);
    if (!runtime.isCurrent()) return;
    const result = await runPiDispatch(
      pi,
      runtime.session,
      ctx,
      {
        eventName: HOOK_EVENT.stop,
        event,
        extraPayload: { [STOP_HOOK_ACTIVE_FIELD]: refusals > 0 },
      },
      `${STATUS_PREFIX}:${ctx.sessionManager.getSessionId()}:stop`,
      'Running stop hooks',
    );
    if (!runtime.isCurrent()) return;
    if (result.failures.length > 0)
      pi.sendMessage(
        {
          customType: FAILURE_MESSAGE_TYPE,
          content: hookFailureMessage(result.failures),
          display: true,
        },
        NO_TURN,
      );
    const reason = decisionReason(result.decisions.find(isDenied));
    if (!reason) {
      refusals = 0;
      return;
    }
    if (refusals >= MAX_STOP_REFUSALS) {
      refusals = 0;
      pi.sendMessage(
        {
          customType: FAILURE_MESSAGE_TYPE,
          content: `A Stop hook refused ${String(MAX_STOP_REFUSALS)} stops in a row, so the agent stops here. Its last reason: ${reason}`,
          display: true,
        },
        NO_TURN,
      );
      return;
    }
    refusals += 1;
    pi.sendMessage({ customType: STOP_BLOCK_MESSAGE_TYPE, content: reason, display: true }, FOLLOW_UP_TURN);
  };
}

export function createHookHandlers(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): PiEventHandlers {
  let shutdown: Promise<void> | undefined;
  return {
    session_start: createSessionStart(pi, resolveRuntime),
    before_agent_start: createBeforeAgentStart(resolveRuntime),
    tool_call: createToolCall(pi, resolveRuntime),
    tool_result: createToolResult(pi, resolveRuntime),
    agent_settled: createAgentSettled(pi, resolveRuntime),
    session_shutdown: (_event, ctx) => {
      const current = resolveRuntime();
      if (!current?.isCurrent() || scopeFor(pi, current.session, ctx).isSubagent) return undefined;
      shutdown ??= runSessionEndHooks(pi, current.session, ctx);
      return shutdown;
    },
  };
}

/** SessionEnd remains plugin-only and once-only while the session is still usable. */
export async function runSessionEndHooks(pi: ExtensionAPI, session: HookSession, ctx: ExtensionContext): Promise<void> {
  await runPiDispatch(
    pi,
    session,
    ctx,
    { eventName: HOOK_EVENT.sessionEnd },
    `${STATUS_PREFIX}:${ctx.sessionManager.getSessionId()}:end`,
    'Running session-end hooks',
  );
}
