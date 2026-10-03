import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { DoomConfigContext } from '@agimon-ai/doompi-config/types';
import { DOOM_CHILD_SESSION_HOOKS_SERVICE, type DoomChildSessionHooks } from '@agimon-ai/doompi-core/childSession';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { type DoomReadinessCoordinator, readDoomReadinessCoordinator } from '@agimon-ai/doompi-core/readiness';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext, ToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { PACKAGE_SOURCE } from '../../constants/hook';
import { HOOK_EVENT } from '../../constants/hooks';
import type { HookContext, JsonValue } from '../../types/hookModule';
import type { HookTelemetry } from '../../types/telemetry';
import { hookFailureMessage } from '../hookDecisions';
import { dispatchHooks } from '../hookDispatch';
import { createHookDocumentReader } from '../hookDocuments';
import { createHookModules } from '../hookModules';
import { createBashHookRunner } from '../hookRunner';
import { createHookTelemetry } from '../hookTelemetry';
import { DOOM_HOOK_SESSION_SERVICE, type HookReadinessGate, type HookSession } from './type';
import type { HookBinding, HookExtensionOptions, HookRuntimeBinding } from './type';

export function createHookSession(
  config: () => DoomConfigContext,
  options: HookExtensionOptions,
  signal: AbortSignal,
): HookSession {
  // The log sink is only built if something actually reports to it, so a fully
  // stubbed session never touches the telemetry backend.
  let telemetry = options.telemetry;
  const requireTelemetry = (): HookTelemetry => (telemetry ??= createHookTelemetry());
  return {
    config,
    signal,
    modules: createHookModules({ descriptor: config().harness.hookModules }),
    runner: options.runner ?? createBashHookRunner({ telemetry: requireTelemetry() }),
    documents: options.documents ?? createHookDocumentReader({ telemetry: requireTelemetry() }),
  };
}

function childHooksFor(parent: HookSession): DoomChildSessionHooks {
  return {
    bind(scope) {
      // Children retain their launch selection and artifacts, even if the parent reloads.
      const config = structuredClone(parent.config());
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, scope.signal]);
      const session = createHookSession(() => config, { runner: parent.runner, documents: parent.documents }, signal);
      let disposal: Promise<void> | undefined;
      const context = (): HookContext => {
        const sessionId = scope.sessionId();
        if (!sessionId) throw new Error('Child hook identity is unavailable before runtime startup.');
        return {
          sessionId,
          parentSessionId: scope.request.parentSessionId,
          agent: scope.request.agent,
          isSubagent: true,
          cwd: scope.request.cwd,
          repoRoot: config.harness.root ?? scope.request.cwd,
          signal,
          sendMessage: (text, delivery) => scope.sendMessage(text, delivery),
          appendCustomEntry: (type, data) => scope.appendCustomEntry(type, data),
        };
      };
      return {
        async beforeTool(event, execution) {
          const native = { type: 'tool_call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args } as ToolCallEvent;
          const result = await dispatchHooks(session, { ...context(), operationSignal: execution.abortSignal }, {
            eventName: HOOK_EVENT.preToolUse,
            event: native,
          });
          if (result.failures.length > 0) await scope.sendMessage(hookFailureMessage(result.failures), 'steer');
          return result.toolCall?.block
            ? { block: { reason: result.toolCall.reason ?? 'Blocked by repository hook' } }
            : { args: native.input as Record<string, JsonValue> };
        },
        async afterTool(event, execution) {
          const native = {
            type: 'tool_result', toolCallId: event.toolCallId, toolName: event.toolName,
            input: event.args, content: event.content, details: event.details, isError: event.isError,
          } as ToolResultEvent;
          const result = await dispatchHooks(session, { ...context(), operationSignal: execution.abortSignal }, {
            eventName: HOOK_EVENT.postToolUse,
            event: native,
          });
          return result.toolResult ? {
            content: result.toolResult.content,
            details: result.toolResult.details as JsonValue | undefined,
            isError: result.toolResult.isError,
          } : undefined;
        },
        dispose() {
          disposal ??= (async () => {
            controller.abort();
            await session.modules.dispose();
          })();
          return disposal;
        },
      };
    },
  };
}

export function createHookRuntime(
  cordis: Context,
  options: HookExtensionOptions,
  lifetimeSignal?: AbortSignal,
): HookRuntimeBinding {
  const controller = new AbortController();
  const signal = lifetimeSignal ? AbortSignal.any([controller.signal, lifetimeSignal]) : controller.signal;
  const session = createHookSession(() => requireDoomConfigContext(cordis), options, signal);
  let disposal: Promise<void> | undefined;
  let active = true;
  let generation = 0;
  let readiness:
    | {
        readonly sessionManager: object;
        readonly coordinator: DoomReadinessCoordinator;
        readonly operation: Promise<void>;
      }
    | undefined;
  const readinessGate: HookReadinessGate = {
    start(context, operation) {
      const ownGeneration = ++generation;
      const isCurrent = (): boolean => active && ownGeneration === generation;
      const coordinator = readDoomReadinessCoordinator(cordis);
      if (!coordinator) return operation(new AbortController().signal, isCurrent);

      const previous = readiness;
      const readinessOperation = (async (): Promise<void> => {
        if (previous?.coordinator === coordinator) await previous.operation.catch(() => undefined);
        if (!isCurrent()) return;
        const handle = coordinator.start(
          PACKAGE_SOURCE,
          `${context.sessionManager.getSessionId()}:${ownGeneration}`,
          async (signal) => {
            await operation(signal, isCurrent);
            return { value: undefined };
          },
        );
        await handle.wait();
      })();
      // Config's coordinator owns the single user-facing failure notification.
      void readinessOperation.catch(() => undefined);
      readiness = {
        sessionManager: context.sessionManager,
        coordinator,
        operation: readinessOperation,
      };
      return undefined;
    },
    async wait(context: ExtensionContext): Promise<void> {
      const current = readiness;
      if (!current) return;
      if (current.sessionManager !== context.sessionManager) {
        throw new Error('Hook readiness belongs to a stale Pi session.');
      }
      await current.operation;
      if (!active || current !== readiness) {
        throw new Error('Hook readiness belongs to a stale extension generation.');
      }
    },
  };
  return {
    session,
    readiness: readinessGate,
    childHooks: childHooksFor(session),
    isCurrent: () => active && !signal.aborted,
    dispose() {
      active = false;
      generation += 1;
      readiness = undefined;
      controller.abort();
      disposal ??= session.modules.dispose();
      return disposal;
    },
  };
}

export function createHookBinding(options: HookExtensionOptions): HookBinding {
  let runtime: HookRuntimeBinding | undefined;
  return {
    plugin(cordis) {
      cordis.inject([DOOM_CONFIG_SERVICE], (configContext) => {
        const binding = createHookRuntime(configContext, options);
        runtime = binding;
        configContext.provide(DOOM_CHILD_SESSION_HOOKS_SERVICE, binding.childHooks);
        configContext.provide(DOOM_HOOK_SESSION_SERVICE, binding);
        return async () => {
          if (runtime === binding) runtime = undefined;
          await binding.dispose();
        };
      });
    },
    runtime: () => runtime,
  };
}
