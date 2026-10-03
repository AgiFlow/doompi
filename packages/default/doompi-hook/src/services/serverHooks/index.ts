import {
  DoomHeadlessPromptAdmissionError,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
} from '@agimon-ai/doompi-core/headless';
import type { ToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { BLOCKED_BY_HOOK, STATUS_PREFIX, SUBAGENT_ENVIRONMENT_FLAG } from '../../constants/hookHandlers';
import { HOOK_EVENT } from '../../constants/hooks';
import { hookFailureMessage } from '../hookDecisions';
import { dispatchHooks } from '../hookDispatch';
import type { HookDispatchScope } from '../hookDispatch/type';
import type { HookRuntime, HookRuntimeResolver } from '../hookRuntime/type';

function hookEntry(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { version: 1, event: typeof event.type === 'string' ? event.type : 'headless-hook', data: event };
}

function scopeFor(runtime: HookRuntime, execution: DoomHeadlessExecutionContext): HookDispatchScope {
  return {
    sessionId: execution.sessionId,
    isSubagent: Boolean(execution.environment[SUBAGENT_ENVIRONMENT_FLAG]),
    cwd: execution.cwd,
    repoRoot: execution.repoRoot,
    model: execution.model,
    signal: runtime.session.signal,
    operationSignal: execution.signal,
    async sendMessage(text, delivery) {
      if (!execution.session.admitPrompt)
        throw new DoomHeadlessPromptAdmissionError('The session cannot admit a hook prompt.');
      await execution.session.admitPrompt(text, delivery);
    },
    appendCustomEntry: (type, data) => execution.session.appendCustomEntry(type, data),
  };
}

/** Server facets own tool dispatch. Lifecycle rows belong only to the Pi bridge. */
export function createServerHooks(resolveRuntime: HookRuntimeResolver) {
  const beforeAgentStart: DoomHeadlessHook<'before_agent_start'> = {
    event: 'before_agent_start',
    handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
  };
  const toolCall: DoomHeadlessHook<'tool_call'> = {
    event: 'tool_call',
    async handle(event, execution) {
      const runtime = resolveRuntime();
      if (!runtime?.isCurrent()) return;
      const scope = scopeFor(runtime, execution);
      const native = {
        type: 'tool_call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
      } as ToolCallEvent;
      const key = `${STATUS_PREFIX}:${native.toolCallId}:pre`;
      try {
        const result = await dispatchHooks(runtime.session, scope, {
          eventName: HOOK_EVENT.preToolUse,
          event: native,
          progress: (index, total) =>
            execution.client.setStatus(key, `Running pre-tool hooks for ${native.toolName} (${index + 1}/${total})...`),
        });
        if (result.failures.length > 0) await scope.sendMessage(hookFailureMessage(result.failures), 'steer');
        return result.toolCall?.block
          ? { block: { reason: result.toolCall.reason ?? BLOCKED_BY_HOOK } }
          : { args: native.input };
      } finally {
        execution.client.setStatus(key, undefined);
      }
    },
  };
  const toolResult: DoomHeadlessHook<'tool_result'> = {
    event: 'tool_result',
    async handle(event, execution) {
      await execution.session.appendCustomEntry('doom-hook', hookEntry(event));
      const runtime = resolveRuntime();
      if (!runtime?.isCurrent()) return;
      const native = {
        type: 'tool_result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
        content: event.content,
        details: event.details,
        isError: event.isError,
      } as ToolResultEvent;
      const key = `${STATUS_PREFIX}:${native.toolCallId}:post`;
      try {
        const result = await dispatchHooks(runtime.session, scopeFor(runtime, execution), {
          eventName: HOOK_EVENT.postToolUse,
          event: native,
          progress: (index, total) =>
            execution.client.setStatus(
              key,
              `Running post-tool hooks for ${native.toolName} (${index + 1}/${total})...`,
            ),
        });
        return result.toolResult;
      } finally {
        execution.client.setStatus(key, undefined);
      }
    },
  };
  const agentSettled: DoomHeadlessHook<'agent_settled'> = {
    event: 'agent_settled',
    handle: (event, execution) => execution.session.appendCustomEntry('doom-hook', hookEntry(event)),
  };
  const sessionShutdown: DoomHeadlessHook<'session_shutdown'> = {
    event: 'session_shutdown',
    handle(_event, execution) {
      execution.client.setStatus('doom-hook', undefined);
    },
  };
  return { beforeAgentStart, toolCall, toolResult, agentSettled, sessionShutdown };
}
