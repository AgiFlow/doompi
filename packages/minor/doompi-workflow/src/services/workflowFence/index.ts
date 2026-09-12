import type { PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';
import type { DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  readChildProcessContext,
  resolveRootSessionId,
  SUBAGENT_PARENT_SESSION_ENV,
} from '@agimon-ai/doompi-core/child-process';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

const DISPATCHER_AGENT_NAME = 'agiflow-dispatcher';
const SESSION_START_EVENT = 'session_start';
const INACTIVE_RUNTIME_MESSAGE = 'The workflow runtime is no longer active.';
const CLEANUP_SCOPE = Symbol('doom-workflow-cleanup');

const DISPATCHER_TOOL_NAMES = new Set(['list_workflows', 'launch_workflow']);
const ROOT_SCOPED_TOOL_NAMES = new Set(['launch_workflow']);
const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';

type ToolSchema = Parameters<ExtensionAPI['registerTool']>[0]['parameters'];
type CommandOptions = Parameters<ExtensionAPI['registerCommand']>[1];
type ShortcutOptions = Parameters<ExtensionAPI['registerShortcut']>[1];
type RuntimeScope = number | typeof CLEANUP_SCOPE;
type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;

export interface WorkflowFence {
  tool<TSchema extends ToolSchema, TDetails>(
    tool: ToolDefinition<TSchema, TDetails>,
  ): ToolDefinition<TSchema, TDetails>;
  command(name: string, options: CommandOptions): readonly [string, CommandOptions];
  shortcut(
    shortcut: Parameters<ExtensionAPI['registerShortcut']>[0],
    options: ShortcutOptions,
  ): readonly [Parameters<ExtensionAPI['registerShortcut']>[0], ShortcutOptions];
  events(handlers: PiEventHandlers): PiEventHandlers;
  readonly pi: ExtensionAPI;
  readonly beginDisposal: () => void;
  readonly finishDisposal: () => void;
  readonly isCurrentInvocation: () => boolean;
  readonly runCleanup: <T>(operation: () => T) => T;
}

function boundValue(target: object, property: PropertyKey): unknown {
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

function withParentSession(ctx: ExtensionContext, parentSessionId: string): ExtensionContext {
  const sessionManager = new Proxy(ctx.sessionManager, {
    get(target, property) {
      if (property === 'getSessionId') return () => parentSessionId;
      return boundValue(target, property);
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'sessionManager') return sessionManager;
      return boundValue(target, property);
    },
  });
}

/**
 * A dispatcher child launches workflows for its root session and never runs one
 * itself, so `workflow_run` stays off its surface even if something registers it.
 */
export function dispatcherToolRestriction(): DoomToolRestriction {
  return (incoming) => incoming.filter((name) => name !== WORKFLOW_RUN_TOOL_NAME);
}

/** Restrict a dispatcher child to discovery and root-owned launch. */
export function dispatcherTools<TSchema extends ToolSchema, TDetails>(
  tools: readonly ToolDefinition<TSchema, TDetails>[],
  parentSessionId: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): ToolDefinition<TSchema, TDetails>[] {
  const rootSessionId = parentSessionId ? resolveRootSessionId(parentSessionId, environment) : undefined;
  return tools
    .filter((tool) => DISPATCHER_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      if (!rootSessionId || !ROOT_SCOPED_TOOL_NAMES.has(tool.name)) return tool;
      return {
        ...tool,
        execute: (toolCallId, params, signal, onUpdate, ctx) =>
          tool.execute(toolCallId, params, signal, onUpdate, withParentSession(ctx, rootSessionId)),
      };
    });
}

export function resolveDispatcherParentSession(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const childContext = readChildProcessContext(environment);
  return childContext?.parentSessionId ?? (environment[SUBAGENT_PARENT_SESSION_ENV]?.trim() || undefined);
}

export function isWorkflowDispatcherProcess(environment: Readonly<Record<string, string | undefined>>): boolean {
  const childContext = readChildProcessContext(environment);
  if (childContext?.mode === DISPATCHER_AGENT_NAME) return true;
  return (
    environment.PI_SUBAGENT_CHILD_AGENT === DISPATCHER_AGENT_NAME &&
    Boolean(environment[SUBAGENT_PARENT_SESSION_ENV]?.trim())
  );
}

/** Fence every callback retained by Pi after this package root is replaced. */
export function createWorkflowFence(host: ExtensionAPI, signal?: AbortSignal): WorkflowFence {
  const scope = new AsyncLocalStorage<RuntimeScope>();
  let active = true;
  let disposing = false;
  let generation = 0;
  let lastSessionStartEvent: unknown;
  let lastSessionStartContext: ExtensionContext | undefined;

  const isCurrentInvocation = (): boolean => {
    const currentScope = scope.getStore();
    if (!active || (signal?.aborted && currentScope !== CLEANUP_SCOPE)) return false;
    return currentScope === undefined || currentScope === CLEANUP_SCOPE || currentScope === generation;
  };
  const ownsContext = (contextGeneration: number): boolean => {
    const currentScope = scope.getStore();
    if (!active || (signal?.aborted && currentScope !== CLEANUP_SCOPE)) return false;
    return (
      currentScope === CLEANUP_SCOPE ||
      (contextGeneration === generation && (currentScope === undefined || currentScope === contextGeneration))
    );
  };

  const guardContext = <TContext extends ExtensionContext>(context: TContext, contextGeneration: number): TContext => {
    const guardedUi = new Proxy(context.ui, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          if (ownsContext(contextGeneration)) return Reflect.apply(value, target, args);
          if (property === 'confirm') return Promise.resolve(false);
          if (property === 'custom' || property === 'editor' || property === 'input' || property === 'select') {
            return Promise.resolve(undefined);
          }
          return undefined;
        };
      },
    });
    return new Proxy(context, {
      get(target, property) {
        if (property === 'ui') return guardedUi;
        return boundValue(target, property);
      },
    }) as TContext;
  };

  const tool = <TSchema extends ToolSchema, TDetails>(
    definition: ToolDefinition<TSchema, TDetails>,
  ): ToolDefinition<TSchema, TDetails> => {
    return {
      ...definition,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        const executionGeneration = generation;
        if (!active || disposing || signal?.aborted) throw new Error(INACTIVE_RUNTIME_MESSAGE);
        const guardedContext = guardContext(context, executionGeneration);
        const guardedUpdate = onUpdate
          ? (update: Parameters<NonNullable<typeof onUpdate>>[0]): void => {
              if (active && executionGeneration === generation && !signal?.aborted) onUpdate(update);
            }
          : undefined;
        const result = await scope.run(executionGeneration, () =>
          definition.execute(toolCallId, params, signal, guardedUpdate, guardedContext),
        );
        if (!active || disposing || executionGeneration !== generation) throw new Error(INACTIVE_RUNTIME_MESSAGE);
        return result;
      },
    };
  };

  const command: WorkflowFence['command'] = (name, options) => {
    return [
      name,
      {
        ...options,
        handler: async (args, context) => {
          const executionGeneration = generation;
          if (!active || disposing) return;
          await scope.run(executionGeneration, () => options.handler(args, guardContext(context, executionGeneration)));
        },
      },
    ];
  };

  const shortcut: WorkflowFence['shortcut'] = (key, options) => {
    return [
      key,
      {
        ...options,
        handler: (context) => {
          const executionGeneration = generation;
          if (!active || disposing) return;
          return scope.run(executionGeneration, () => options.handler(guardContext(context, executionGeneration)));
        },
      },
    ];
  };

  const events = (handlers: PiEventHandlers): PiEventHandlers =>
    Object.fromEntries(
      Object.entries(handlers).map(([eventName, handler]) => [
        eventName,
        (event: unknown, context: ExtensionContext) => {
          if (!active || disposing) return undefined;
          if (
            eventName === SESSION_START_EVENT &&
            (event !== lastSessionStartEvent || context !== lastSessionStartContext)
          ) {
            generation += 1;
            lastSessionStartEvent = event;
            lastSessionStartContext = context;
          }
          const eventGeneration = generation;
          return scope.run(eventGeneration, () =>
            (handler as LifecycleHandler)(event, guardContext(context, eventGeneration)),
          );
        },
      ]),
    ) as PiEventHandlers;

  const guardedPi = new Proxy(host, {
    get(target, property) {
      if (property === 'sendMessage') {
        return (...args: Parameters<ExtensionAPI['sendMessage']>): void => {
          if (isCurrentInvocation()) target.sendMessage(...args);
        };
      }
      if (property === 'sendUserMessage') {
        return (...args: Parameters<ExtensionAPI['sendUserMessage']>): void => {
          if (isCurrentInvocation()) target.sendUserMessage(...args);
        };
      }
      if (property === 'exec') {
        return (...args: Parameters<ExtensionAPI['exec']>): ReturnType<ExtensionAPI['exec']> =>
          isCurrentInvocation()
            ? target.exec(...args)
            : Promise.resolve({ code: 1, killed: false, stderr: INACTIVE_RUNTIME_MESSAGE, stdout: '' });
      }
      return boundValue(target, property);
    },
  });

  return {
    pi: guardedPi,
    tool,
    command,
    shortcut,
    events,
    beginDisposal() {
      if (disposing || !active) return;
      disposing = true;
      generation += 1;
    },
    finishDisposal() {
      active = false;
      disposing = false;
      generation += 1;
    },
    isCurrentInvocation,
    runCleanup: (operation) => scope.run(CLEANUP_SCOPE, operation),
  };
}
