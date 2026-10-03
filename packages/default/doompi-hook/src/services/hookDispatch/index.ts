import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { BLOCKED_BY_HOOK, CONTEXT_SEPARATOR } from '../../constants/hookHandlers';
import { HOOK_EVENT } from '../../constants/hooks';
import type { HookFailure, HookToolEvent, ResolvedHook } from '../../types/hooks';
import {
  additionalContextsFrom,
  decisionReason,
  hookFailureMessage,
  isDenied,
  toolResultMessages,
} from '../hookDecisions';
import { sessionHookPayload, toolHookPayload } from '../hookPayload';
import { selectRegistryHooks } from '../hookRegistry';
import type { HookSession } from '../hookRuntime/type';
import { selectPluginHooks } from '../pluginHooks';
import type { HookDispatchRequest, HookDispatchResult, HookDispatchScope } from './type';

function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid =
    (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) &&
    Object.values(value).every((entry) => isJson(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function commandFailure(row: ResolvedHook, error: unknown): HookFailure {
  return {
    command: row.hook.command ?? row.hook.module,
    message: error instanceof Error ? error.message : String(error),
    reason: 'hook_execution',
  };
}

/** Registry rows interleave command and module bindings, followed by plugin commands. */
export async function dispatchHooks(
  session: HookSession,
  scope: HookDispatchScope,
  request: HookDispatchRequest,
): Promise<HookDispatchResult> {
  const signal = scope.operationSignal ? AbortSignal.any([scope.signal, scope.operationSignal]) : scope.signal;
  signal.throwIfAborted();
  const harness = session.config().harness;
  const plugins = await session.documents.plugins(harness.pluginHooks);
  const registry =
    request.eventName === HOOK_EVENT.sessionEnd
      ? { entries: [], failure: undefined }
      : await session.documents.registry(scope.repoRoot);
  signal.throwIfAborted();
  const event = request.event;
  const toolName = event && 'toolName' in event ? event.toolName : undefined;
  const hooks = [
    ...selectRegistryHooks(registry.entries, {
      event: request.eventName,
      toolName,
      allowedGroups: harness.hookGroups,
      inSubagent: scope.isSubagent,
    }),
    ...selectPluginHooks(plugins.documents, request.eventName, toolName),
  ];
  const decisions: HookDispatchResult['decisions'] = [];
  const failures = [...(registry.failure ? [registry.failure] : []), ...plugins.failures];
  let toolCall: HookDispatchResult['toolCall'];
  let patchedResult = false;
  for (const [index, row] of hooks.entries()) {
    signal.throwIfAborted();
    request.progress?.(index, hooks.length);
    if (row.hook.command === undefined) {
      if (!event) continue;
      let proposed: typeof event;
      try {
        proposed = structuredClone(event);
      } catch (error) {
        failures.push(commandFailure(row, error));
        continue;
      }
      const outcome = await session.modules.invoke(row, proposed, scope, scope.operationSignal);
      signal.throwIfAborted();
      if (outcome.failure) {
        failures.push(outcome.failure);
        continue;
      }
      // A failed or late invocation cannot mutate live tool input or output.
      try {
        if (event.type === 'tool_call' && proposed.type === 'tool_call') {
          if (
            typeof proposed.input !== 'object' ||
            proposed.input === null ||
            Array.isArray(proposed.input) ||
            !isJson(proposed.input)
          ) {
            throw new Error('Hook tool input must be a JSON object.');
          }
          const input = structuredClone(proposed.input);
          for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
          Object.assign(event.input, input);
          if (outcome.result && 'block' in outcome.result && outcome.result.block) {
            toolCall = { block: true, reason: outcome.result.reason ?? BLOCKED_BY_HOOK };
            break;
          }
        } else if (event.type === 'tool_result' && outcome.result) {
          const patch = structuredClone(outcome.result);
          if ('content' in patch && patch.content !== undefined) event.content = patch.content;
          if ('details' in patch) event.details = patch.details;
          if ('isError' in patch && patch.isError !== undefined) event.isError = patch.isError;
          patchedResult = true;
        }
      } catch (error) {
        failures.push(commandFailure(row, error));
      }
      continue;
    }
    const payload =
      event && 'toolName' in event
        ? toolHookPayload(event as HookToolEvent, request.eventName, scope.repoRoot, scope.sessionId, {
            parentSessionId: scope.parentSessionId,
            agent: scope.agent,
          })
        : sessionHookPayload(scope.sessionId, scope.repoRoot);
    // The catch covers hook execution only. Readiness, host effects and abort errors propagate.
    let outcome;
    try {
      outcome = await session.runner.run(
        row.hook,
        { ...payload, ...request.extraPayload },
        {
          repoRoot: scope.repoRoot,
          pluginRoot: row.root,
        },
      );
    } catch (error) {
      failures.push(commandFailure(row, error));
      continue;
    }
    signal.throwIfAborted();
    if (outcome.failure) failures.push(outcome.failure);
    if (!outcome.decision) continue;
    decisions.push(outcome.decision);
    if (event?.type === 'tool_result') {
      const messages = toolResultMessages([outcome.decision]);
      if (messages.length > 0)
        event.content = [...event.content, { type: 'text', text: messages.join(CONTEXT_SEPARATOR) }];
      if (isDenied(outcome.decision)) event.isError = true;
      patchedResult ||= messages.length > 0 || isDenied(outcome.decision);
    }
    if (isDenied(outcome.decision)) {
      if (event?.type === 'tool_call')
        toolCall = {
          block: true,
          reason: decisionReason(outcome.decision) ?? BLOCKED_BY_HOOK,
        };
      break;
    }
  }
  if (event?.type === 'tool_call' && !toolCall) {
    const context = additionalContextsFrom(decisions).join(CONTEXT_SEPARATOR);
    if (context) toolCall = { block: true, reason: context };
  }
  if (event?.type === 'tool_result' && failures.length > 0) {
    event.content = [...event.content, { type: 'text', text: hookFailureMessage(failures) }];
    patchedResult = true;
  }
  return {
    decisions,
    failures,
    ...(toolCall ? { toolCall } : {}),
    ...(event?.type === 'tool_result' && patchedResult
      ? {
          toolResult: {
            content: (event as ToolResultEvent).content,
            details: (event as ToolResultEvent).details,
            isError: event.isError,
          },
        }
      : {}),
  };
}
