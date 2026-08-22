import type { DoomConfigContext } from '@agimon-ai/doompi-config/types';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  additionalContextsFrom,
  decisionReason,
  decisionsFrom,
  failuresFrom,
  hookFailureMessage,
  isDenied,
  toolResultMessages,
} from '../../services/hookDecisions.ts';
import { sessionHookPayload, toolHookPayload } from '../../services/hookPayload.ts';
import { selectRegistryHooks } from '../../services/hookRegistry.ts';
import { selectPluginHooks } from '../../services/pluginHooks.ts';
import {
  HOOK_EVENT,
  type HookDocumentReader,
  type HookFailure,
  type HookOutcome,
  type HookPayload,
  type HookRunner,
  type HookToolEvent,
  type ResolvedHook,
} from '../../types/hooks.ts';

const STATUS_PREFIX = 'repository-hooks';
const FAILURE_MESSAGE_TYPE = 'repository-hook-failure';
const CONTEXT_MESSAGE_TYPE = 'repository-hook-context';
const STEER = { deliverAs: 'steer' } as const;
const BLOCKED_BY_HOOK = 'Blocked by repository hook';
const SUBAGENT_ENVIRONMENT_FLAG = 'PI_SUBAGENT_CHILD';
const CONTEXT_SEPARATOR = '\n\n';

/** The two collaborators a dispatch needs, both replaceable in tests. */
export interface HookSession {
  config(): DoomConfigContext;
  runner: HookRunner;
  documents: HookDocumentReader;
}

/** Package-scoped startup ordering supplied by the standard Pi adapter. */
export interface HookReadinessGate {
  start(
    context: ExtensionContext,
    operation: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>,
  ): void | Promise<void>;
  wait(context: ExtensionContext): Promise<void>;
}

/** One dependency-complete Hook runtime owned by a reactive Cordis fiber. */
export interface HookRuntime {
  readonly session: HookSession;
  readonly readiness?: HookReadinessGate;
  isCurrent(): boolean;
}

export type HookRuntimeResolver = () => HookRuntime | undefined;

/** Everything one dispatch resolved before it ran anything. */
interface HookDispatch {
  repoRoot: string;
  sessionId: string;
  hooks: ResolvedHook[];
  failures: HookFailure[];
}

/**
 * Registry rows plus plugin hooks for one event, in that order.
 *
 * Both sources are read on every dispatch because either can change mid-session:
 * /mode switches the selected groups and a plugin can rewrite its own config.
 */
async function resolveHooks(
  session: HookSession,
  ctx: ExtensionContext,
  eventName: string,
  toolName?: string,
): Promise<HookDispatch> {
  const harness = session.config().harness;
  const repoRoot = harness.root ?? ctx.cwd;
  const [registry, plugins] = await Promise.all([
    session.documents.registry(repoRoot),
    session.documents.plugins(harness.pluginHooks),
  ]);
  const hooks = [
    ...selectRegistryHooks(registry.entries, {
      event: eventName,
      toolName,
      allowedGroups: harness.hookGroups,
      inSubagent: Boolean(process.env[SUBAGENT_ENVIRONMENT_FLAG]),
    }),
    ...selectPluginHooks(plugins.documents, eventName, toolName),
  ];
  return {
    repoRoot,
    sessionId: ctx.sessionManager.getSessionId(),
    hooks,
    failures: [...(registry.failure ? [registry.failure] : []), ...plugins.failures],
  };
}

/** Session end is plugin-only: the registry has no binding for it. */
async function resolvePluginHooks(
  session: HookSession,
  ctx: ExtensionContext,
  eventName: string,
): Promise<HookDispatch> {
  const harness = session.config().harness;
  const plugins = await session.documents.plugins(harness.pluginHooks);
  return {
    repoRoot: harness.root ?? ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    hooks: selectPluginHooks(plugins.documents, eventName),
    failures: plugins.failures,
  };
}

async function runHooks(
  session: HookSession,
  ctx: ExtensionContext,
  dispatch: HookDispatch,
  payload: HookPayload,
  statusKey: string,
  statusLabel: string,
): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  try {
    for (const [index, resolved] of dispatch.hooks.entries()) {
      if (ctx.hasUI) ctx.ui.setStatus(statusKey, `${statusLabel} (${index + 1}/${dispatch.hooks.length})...`);
      outcomes.push(
        await session.runner.run(resolved.hook, payload, { repoRoot: dispatch.repoRoot, pluginRoot: resolved.root }),
      );
    }
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
  }
  return outcomes;
}

function allFailures(dispatch: HookDispatch, outcomes: ReadonlyArray<HookOutcome>): HookFailure[] {
  return [...dispatch.failures, ...failuresFrom(outcomes)];
}

function steerHookFailures(pi: ExtensionAPI, failures: ReadonlyArray<HookFailure>): void {
  if (failures.length === 0) return;
  pi.sendMessage({ customType: FAILURE_MESSAGE_TYPE, content: hookFailureMessage(failures), display: true }, STEER);
}

async function runSessionStartHooks(
  pi: ExtensionAPI,
  session: HookSession,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  signal?.throwIfAborted();
  const dispatch = await resolveHooks(session, ctx, HOOK_EVENT.sessionStart);
  signal?.throwIfAborted();
  const outcomes = await runHooks(
    session,
    ctx,
    dispatch,
    sessionHookPayload(dispatch.sessionId, dispatch.repoRoot),
    `${STATUS_PREFIX}:${dispatch.sessionId}:start`,
    'Running session-start hooks',
  );
  signal?.throwIfAborted();
  if (!isCurrent()) return;
  steerHookFailures(pi, allFailures(dispatch, outcomes));
  const context = additionalContextsFrom(decisionsFrom(outcomes)).join(CONTEXT_SEPARATOR);
  if (context) pi.sendMessage({ customType: CONTEXT_MESSAGE_TYPE, content: context, display: true }, STEER);
}

function registerSessionStart(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): void {
  pi.on('session_start', (_event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return undefined;
    const { readiness, session } = runtime;
    if (readiness) {
      return readiness.start(ctx, (signal, isReady) =>
        runSessionStartHooks(pi, session, ctx, signal, () => runtime.isCurrent() && isReady()),
      );
    }
    return runSessionStartHooks(pi, session, ctx);
  });
}

function registerBeforeAgentStart(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): void {
  pi.on('before_agent_start', async (_event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return;
    await runtime.readiness?.wait(ctx);
  });
}

function registerToolCall(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): void {
  pi.on('tool_call', async (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return undefined;
    await runtime.readiness?.wait(ctx);
    if (!runtime.isCurrent()) return undefined;
    const dispatch = await resolveHooks(runtime.session, ctx, HOOK_EVENT.preToolUse, event.toolName);
    if (!runtime.isCurrent()) return undefined;
    const payload = toolHookPayload(
      event as HookToolEvent,
      HOOK_EVENT.preToolUse,
      dispatch.repoRoot,
      dispatch.sessionId,
    );
    const outcomes = await runHooks(
      runtime.session,
      ctx,
      dispatch,
      payload,
      `${STATUS_PREFIX}:${event.toolCallId}:pre`,
      `Running pre-tool hooks for ${event.toolName}`,
    );
    if (!runtime.isCurrent()) return undefined;
    const decisions = decisionsFrom(outcomes);
    steerHookFailures(pi, allFailures(dispatch, outcomes));
    const denied = decisions.find(isDenied);
    if (denied) return { block: true, reason: decisionReason(denied) ?? BLOCKED_BY_HOOK };
    const context = additionalContextsFrom(decisions).join(CONTEXT_SEPARATOR);
    return context ? { block: true, reason: context } : undefined;
  });
}

function registerToolResult(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): void {
  pi.on('tool_result', async (event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return undefined;
    await runtime.readiness?.wait(ctx);
    if (!runtime.isCurrent()) return undefined;
    const dispatch = await resolveHooks(runtime.session, ctx, HOOK_EVENT.postToolUse, event.toolName);
    if (!runtime.isCurrent()) return undefined;
    const payload = toolHookPayload(
      event as HookToolEvent,
      HOOK_EVENT.postToolUse,
      dispatch.repoRoot,
      dispatch.sessionId,
    );
    const outcomes = await runHooks(
      runtime.session,
      ctx,
      dispatch,
      payload,
      `${STATUS_PREFIX}:${event.toolCallId}:post`,
      `Running post-tool hooks for ${event.toolName}`,
    );
    if (!runtime.isCurrent()) return undefined;
    const decisions = decisionsFrom(outcomes);
    const failures = allFailures(dispatch, outcomes);
    const messages = toolResultMessages(decisions);
    if (failures.length > 0) messages.push(hookFailureMessage(failures));
    if (messages.length === 0) return undefined;
    // The result is appended to rather than replaced, so the tool's own output
    // still reaches the model alongside whatever the hook had to say.
    return {
      content: [...event.content, { type: 'text' as const, text: messages.join(CONTEXT_SEPARATOR) }],
      isError: event.isError || decisions.some(isDenied),
    };
  });
}

function registerAgentSettled(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): void {
  pi.on('agent_settled', async (_event, ctx) => {
    const runtime = resolveRuntime();
    if (!runtime?.isCurrent()) return;
    await runtime.readiness?.wait(ctx);
    if (!runtime.isCurrent()) return;
    const dispatch = await resolveHooks(runtime.session, ctx, HOOK_EVENT.stop);
    if (!runtime.isCurrent()) return;
    // skipInSubagent on the workflow-stop binding keeps subagents from closing
    // the parent's workflow step.
    await runHooks(
      runtime.session,
      ctx,
      dispatch,
      sessionHookPayload(dispatch.sessionId, dispatch.repoRoot),
      `${STATUS_PREFIX}:${dispatch.sessionId}:stop`,
      'Running stop hooks',
    );
  });
}

/**
 * Registers the four in-session lifecycle events and returns one disposer each.
 *
 * Pi owns handler deregistration across a reload, so each disposer only has to
 * drop this package's own reference to the session.
 */
export function registerHookHandlers(pi: ExtensionAPI, resolveRuntime: HookRuntimeResolver): Array<() => void> {
  return [
    registerSessionStart,
    registerBeforeAgentStart,
    registerToolCall,
    registerToolResult,
    registerAgentSettled,
  ].map((register) => {
    register(pi, resolveRuntime);
    return () => undefined;
  });
}

/** Runs the plugin SessionEnd hooks while the session is still usable. */
export async function runSessionEndHooks(session: HookSession, ctx: ExtensionContext): Promise<void> {
  const dispatch = await resolvePluginHooks(session, ctx, HOOK_EVENT.sessionEnd);
  await runHooks(
    session,
    ctx,
    dispatch,
    sessionHookPayload(dispatch.sessionId, dispatch.repoRoot),
    `${STATUS_PREFIX}:${dispatch.sessionId}:end`,
    'Running session-end hooks',
  );
}
