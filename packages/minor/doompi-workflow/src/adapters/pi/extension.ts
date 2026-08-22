import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readChildProcessContext,
  resolveRootSessionId,
  SUBAGENT_PARENT_SESSION_ENV,
} from '@agimon-ai/doompi-extension-contracts/child-process';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  DOOM_SKILL_SOURCES_SERVICE,
  requireDoomSkillSourcesService,
} from '@agimon-ai/doompi-extension-contracts/skills';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerLeaderContribution } from './leader.ts';
import { installWorkflowPiRuntime, type WorkflowPiRuntime } from './workflow/piExtension.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-workflow';
const SKILL_RELATIVE_PATH = '../../../skills';
const DISPATCHER_AGENT_NAME = 'agiflow-dispatcher';
const SESSION_START_EVENT = 'session_start';
const SESSION_SHUTDOWN_EVENT = 'session_shutdown';
const INACTIVE_RUNTIME_MESSAGE = 'The workflow runtime is no longer active.';
const CLEANUP_SCOPE = Symbol('doom-workflow-cleanup');

const DISPATCHER_TOOL_NAMES = new Set(['list_workflows', 'launch_workflow']);
const ROOT_SCOPED_TOOL_NAMES = new Set(['launch_workflow']);

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];
type CommandOptions = Parameters<ExtensionAPI['registerCommand']>[1];
type ShortcutOptions = Parameters<ExtensionAPI['registerShortcut']>[1];
type RuntimeScope = number | typeof CLEANUP_SCOPE;
type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;

interface WorkflowFence {
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

/** Restrict a dispatcher child to discovery and root-owned launch. */
export function createDispatcherBridge(
  pi: ExtensionAPI,
  parentSessionId: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExtensionAPI {
  const rootSessionId = parentSessionId ? resolveRootSessionId(parentSessionId, environment) : undefined;
  return new Proxy(pi, {
    get(target, property) {
      if (property === 'setActiveTools') {
        return (names: string[]): void => target.setActiveTools(names.filter((name) => name !== 'workflow_run'));
      }
      if (property !== 'registerTool') return boundValue(target, property);
      return (tool: RegisteredTool): void => {
        if (!DISPATCHER_TOOL_NAMES.has(tool.name)) return;
        if (!rootSessionId || !ROOT_SCOPED_TOOL_NAMES.has(tool.name)) {
          target.registerTool(tool);
          return;
        }
        target.registerTool({
          ...tool,
          execute: (toolCallId, params, signal, onUpdate, ctx) =>
            tool.execute(toolCallId, params, signal, onUpdate, withParentSession(ctx, rootSessionId)),
        });
      };
    },
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

function inactiveToolResult(): Awaited<ReturnType<RegisteredTool['execute']>> {
  return {
    content: [{ type: 'text', text: INACTIVE_RUNTIME_MESSAGE }],
    details: undefined,
  };
}

/** Fence every callback retained by Pi after this package root is replaced. */
function createWorkflowFence(host: ExtensionAPI): WorkflowFence {
  const scope = new AsyncLocalStorage<RuntimeScope>();
  let active = true;
  let disposing = false;
  let generation = 0;
  let lastSessionStartEvent: unknown;
  let lastSessionStartContext: ExtensionContext | undefined;

  const isCurrentInvocation = (): boolean => {
    if (!active) return false;
    const currentScope = scope.getStore();
    return currentScope === undefined || currentScope === CLEANUP_SCOPE || currentScope === generation;
  };
  const ownsContext = (contextGeneration: number): boolean => {
    if (!active) return false;
    const currentScope = scope.getStore();
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

  const registerTool = (tool: RegisteredTool): void => {
    if (!isCurrentInvocation()) return;
    host.registerTool({
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate, context) => {
        const executionGeneration = generation;
        if (!active || disposing || signal?.aborted) return inactiveToolResult();
        const guardedContext = guardContext(context, executionGeneration);
        const guardedUpdate = onUpdate
          ? (update: Parameters<NonNullable<typeof onUpdate>>[0]): void => {
              if (active && executionGeneration === generation && !signal?.aborted) onUpdate(update);
            }
          : undefined;
        const result = await scope.run(executionGeneration, () =>
          tool.execute(toolCallId, params, signal, guardedUpdate, guardedContext),
        );
        return active && !disposing && executionGeneration === generation ? result : inactiveToolResult();
      },
    });
  };

  const registerCommand = (name: string, options: CommandOptions): void => {
    if (!isCurrentInvocation()) return;
    host.registerCommand(name, {
      ...options,
      handler: async (args, context) => {
        const executionGeneration = generation;
        if (!active || disposing) return;
        await scope.run(executionGeneration, () => options.handler(args, guardContext(context, executionGeneration)));
      },
    });
  };

  const registerShortcut = (
    shortcut: Parameters<ExtensionAPI['registerShortcut']>[0],
    options: ShortcutOptions,
  ): void => {
    if (!isCurrentInvocation()) return;
    host.registerShortcut(shortcut, {
      ...options,
      handler: (context) => {
        const executionGeneration = generation;
        if (!active || disposing) return;
        return scope.run(executionGeneration, () => options.handler(guardContext(context, executionGeneration)));
      },
    });
  };

  const guardedPi = new Proxy(host, {
    get(target, property) {
      if (property === 'on') {
        return (eventName: string, handler: LifecycleHandler): void => {
          const registerLifecycleHandler = boundValue(target, 'on') as (
            name: string,
            callback: LifecycleHandler,
          ) => void;
          registerLifecycleHandler(eventName, (event: unknown, context: ExtensionContext) => {
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
            return scope.run(eventGeneration, () => handler(event, guardContext(context, eventGeneration)));
          });
        };
      }
      if (property === 'registerTool') return registerTool;
      if (property === 'registerCommand') return registerCommand;
      if (property === 'registerShortcut') return registerShortcut;
      if (property === 'getActiveTools') {
        return (): string[] => (isCurrentInvocation() ? target.getActiveTools() : []);
      }
      if (property === 'setActiveTools') {
        return (names: string[]): void => {
          if (isCurrentInvocation()) target.setActiveTools(names);
        };
      }
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

/** Install one normal or dispatcher runtime into its host-owned Cordis plugin fiber. */
export function installWorkflowRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  isCurrentInvocation: () => boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dispatcher = isWorkflowDispatcherProcess(environment);
  const parentSessionId = dispatcher ? resolveDispatcherParentSession(environment) : undefined;
  const runtimePi = dispatcher ? createDispatcherBridge(pi, parentSessionId, environment) : pi;

  let runtime: WorkflowPiRuntime | undefined;
  cordis.effect(() => () => (runtime ? runtime.dispose() : Promise.resolve()), `${PACKAGE_SOURCE}/runtime`);

  cordis.inject([DOOM_SKILL_SOURCES_SERVICE], (skillContext) => {
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), SKILL_RELATIVE_PATH);
    if (!existsSync(directory)) return undefined;
    const contribution = requireDoomSkillSourcesService(skillContext).register({
      source: PACKAGE_SOURCE,
      directories: [directory],
    });
    return () => contribution.dispose();
  });

  if (dispatcher) {
    runtime = installWorkflowPiRuntime({ cordis, initialMode: true, isActive: isCurrentInvocation })(runtimePi);
    return;
  }

  let workflowMode = false;
  let leader: ReturnType<typeof registerLeaderContribution> | undefined;
  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const contribution = registerLeaderContribution(requireDoomUiHub(uiContext), workflowMode);
    leader = contribution;
    return () => {
      contribution.dispose();
      if (leader === contribution) leader = undefined;
    };
  });
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const help = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-workflow',
          description:
            'Author DoomPi workflow definitions. Use when creating or changing a *.workflow.yml graph, arranging job dependencies and host-executed steps, or deciding how a command requiring a TTY should run.',
        },
        {
          name: 'doompi-use-workflow',
          description:
            'Use DoomPi workflows. Use when discovering or launching workflows, monitoring or controlling asynchronous runs, interpreting terminal notifications, or recovering a failed run safely.',
        },
      ],
    });
    return () => help.dispose();
  });
  runtime = installWorkflowPiRuntime({
    cordis,
    isActive: isCurrentInvocation,
    onModeChange: (enabled) => {
      workflowMode = enabled;
      leader?.setMode(enabled);
    },
  })(runtimePi);
}

interface WorkflowPluginConfig {
  readonly fence: WorkflowFence;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function workflowPlugin(cordis: Context, { fence, environment }: WorkflowPluginConfig): void {
  installWorkflowRuntime(cordis, fence.pi, fence.isCurrentInvocation, environment);
}

/** The package's sole Pi factory; Pi reloads it and Cordis owns all package resources. */
export async function workflowExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fence = createWorkflowFence(pi);
  const fiber = connection.root.plugin(workflowPlugin, { fence, environment: process.env });
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    fence.beginDisposal();
    disposal = fence.runCleanup(async () => {
      try {
        await fiber.dispose();
      } finally {
        try {
          fence.finishDisposal();
        } finally {
          await connection.dispose();
        }
      }
    });
    return disposal;
  };

  try {
    await fiber;
  } catch (error) {
    await dispose();
    throw error;
  }
  pi.on(SESSION_SHUTDOWN_EVENT, dispose);
}

export default workflowExtension;
