import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

import { connectDoomCordisHost, type DoomCordisRuntimeService } from '../pi/cordisHost';
import { DOOM_HELP_SERVICE, requireDoomHelpService, type DoomHelpService } from '../schemas/help';
import type { PiToolDeclaration } from '../schemas/piTool';
import type { DoomPluginTool, DoomPluginCommand } from '../schemas/pluginContributions';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  requireDoomToolOverrides,
  type DoomToolOverrideClaim,
} from '../schemas/toolOverrides';
import type { DoomToolRestrictionDefinition } from '../schemas/toolSurface';
import { DOOM_TOOL_SURFACE_SERVICE, requireDoomToolSurface } from '../schemas/toolSurface';
import { createPluginLifecycle, type PluginLifecycleHooks } from '../services/pluginLifecycle';

/** Extract native overloads without copying Pi event payload or result contracts. */
type NativeEventOverloads = ExtensionAPI['on'] extends {
  (event: infer E1 extends string, handler: infer H1): void;
  (event: infer E2 extends string, handler: infer H2): void;
  (event: infer E3 extends string, handler: infer H3): void;
  (event: infer E4 extends string, handler: infer H4): void;
  (event: infer E5 extends string, handler: infer H5): void;
  (event: infer E6 extends string, handler: infer H6): void;
  (event: infer E7 extends string, handler: infer H7): void;
  (event: infer E8 extends string, handler: infer H8): void;
  (event: infer E9 extends string, handler: infer H9): void;
  (event: infer E10 extends string, handler: infer H10): void;
  (event: infer E11 extends string, handler: infer H11): void;
  (event: infer E12 extends string, handler: infer H12): void;
  (event: infer E13 extends string, handler: infer H13): void;
  (event: infer E14 extends string, handler: infer H14): void;
  (event: infer E15 extends string, handler: infer H15): void;
  (event: infer E16 extends string, handler: infer H16): void;
  (event: infer E17 extends string, handler: infer H17): void;
  (event: infer E18 extends string, handler: infer H18): void;
  (event: infer E19 extends string, handler: infer H19): void;
  (event: infer E20 extends string, handler: infer H20): void;
  (event: infer E21 extends string, handler: infer H21): void;
  (event: infer E22 extends string, handler: infer H22): void;
  (event: infer E23 extends string, handler: infer H23): void;
  (event: infer E24 extends string, handler: infer H24): void;
  (event: infer E25 extends string, handler: infer H25): void;
  (event: infer E26 extends string, handler: infer H26): void;
  (event: infer E27 extends string, handler: infer H27): void;
  (event: infer E28 extends string, handler: infer H28): void;
  (event: infer E29 extends string, handler: infer H29): void;
  (event: infer E30 extends string, handler: infer H30): void;
  (event: infer E31 extends string, handler: infer H31): void;
  (event: infer E32 extends string, handler: infer H32): void;
  (event: infer E33 extends string, handler: infer H33): void;
  (event: infer E34 extends string, handler: infer H34): void;
  (event: infer E35 extends string, handler: infer H35): void;
  (event: infer E36 extends string, handler: infer H36): void;
  (event: infer E37 extends string, handler: infer H37): void;
  (event: infer E38 extends string, handler: infer H38): void;
  (event: infer E39 extends string, handler: infer H39): void;
  (event: infer E40 extends string, handler: infer H40): void;
}
  ?
      | [E1, H1]
      | [E2, H2]
      | [E3, H3]
      | [E4, H4]
      | [E5, H5]
      | [E6, H6]
      | [E7, H7]
      | [E8, H8]
      | [E9, H9]
      | [E10, H10]
      | [E11, H11]
      | [E12, H12]
      | [E13, H13]
      | [E14, H14]
      | [E15, H15]
      | [E16, H16]
      | [E17, H17]
      | [E18, H18]
      | [E19, H19]
      | [E20, H20]
      | [E21, H21]
      | [E22, H22]
      | [E23, H23]
      | [E24, H24]
      | [E25, H25]
      | [E26, H26]
      | [E27, H27]
      | [E28, H28]
      | [E29, H29]
      | [E30, H30]
      | [E31, H31]
      | [E32, H32]
      | [E33, H33]
      | [E34, H34]
      | [E35, H35]
      | [E36, H36]
      | [E37, H37]
      | [E38, H38]
      | [E39, H39]
      | [E40, H40]
  : never;

export type PiEventHandlers = {
  readonly [Pair in NativeEventOverloads as Pair[0]]?: Pair[1];
};

export interface PiPluginContext<TOptions = undefined> {
  readonly context: Context;
  readonly pi: ExtensionAPI;
  readonly options: TOptions | undefined;
  readonly runtime: DoomCordisRuntimeService | undefined;
  readonly signal: AbortSignal;
}

export type PiToolRestriction = DoomToolRestrictionDefinition;

export interface PiPluginTool extends DoomPluginTool {
  readonly pi?: Pick<Parameters<ExtensionAPI['registerTool']>[0], 'renderShell' | 'renderCall' | 'renderResult'>;
}

export interface PiToolOverride extends DoomToolOverrideClaim {
  /** Contributions registered only while this provider owns the override. */
  readonly tools: readonly string[];
  readonly replacements: readonly (PiToolDeclaration | Parameters<ExtensionAPI['registerTool']>[0])[];
}

export type PiToolContribution = PiPluginTool | PiToolDeclaration | Parameters<ExtensionAPI['registerTool']>[0];

/** Snapshots reuse immutable declarations. A registered name cannot adopt a different declaration until remount. */
export interface PiToolCollection {
  snapshot(): readonly PiToolContribution[];
  subscribe(listener: () => void): () => void;
}

export interface PiPluginContributions<TOptions = undefined> extends PluginLifecycleHooks<PiPluginContext<TOptions>> {
  readonly services?: readonly Parameters<Context['plugin']>[0][];
  readonly tools?: readonly PiToolContribution[] | PiToolCollection;
  readonly commands?: readonly (DoomPluginCommand | readonly [...Parameters<ExtensionAPI['registerCommand']>])[];
  readonly events?: PiEventHandlers;
  readonly resources?: readonly Parameters<DoomHelpService['register']>[0][];
  readonly toolRestrictions?: readonly PiToolRestriction[];
  readonly toolOverrides?: readonly PiToolOverride[];
  readonly providers?: readonly (readonly [...Parameters<ExtensionAPI['registerProvider']>])[];
  readonly messageRenderers?: readonly (readonly [...Parameters<ExtensionAPI['registerMessageRenderer']>])[];
  readonly entryRenderers?: readonly (readonly [...Parameters<ExtensionAPI['registerEntryRenderer']>])[];
  readonly markdownTransformers?: readonly Parameters<ExtensionAPI['registerMarkdownTransformer']>[0][];
  readonly shortcuts?: readonly (readonly [...Parameters<ExtensionAPI['registerShortcut']>])[];
  readonly flags?: readonly (readonly [...Parameters<ExtensionAPI['registerFlag']>])[];
}

export interface PiExtensionDefinition<TOptions = undefined> extends PiPluginContributions<TOptions> {
  readonly name: string;
}

export interface DefinedPiExtension<TOptions = undefined> {
  (pi: ExtensionAPI, options?: TOptions): Promise<void>;
  install(
    this: void,
    context: Context,
    pi: ExtensionAPI,
    options?: TOptions,
    runtime?: DoomCordisRuntimeService,
  ): Promise<void>;
}

export function definePiExtension<TOptions = undefined>(
  definition: PiExtensionDefinition<TOptions>,
): DefinedPiExtension<TOptions>;
export function definePiExtension<TOptions = undefined>(
  name: string,
  factory: (
    context: PiPluginContext<TOptions>,
  ) => PiPluginContributions<TOptions> | Promise<PiPluginContributions<TOptions>>,
): DefinedPiExtension<TOptions>;
export function definePiExtension<TOptions = undefined>(
  definition: string | PiExtensionDefinition<TOptions>,
  factory?: (
    context: PiPluginContext<TOptions>,
  ) => PiPluginContributions<TOptions> | Promise<PiPluginContributions<TOptions>>,
): DefinedPiExtension<TOptions> {
  const name = typeof definition === 'string' ? definition : definition.name;
  const install = async (
    context: Context,
    pi: ExtensionAPI,
    options?: TOptions,
    runtime?: DoomCordisRuntimeService,
  ): Promise<void> => {
    const lifecycle = createPluginLifecycle((signal): PiPluginContext<TOptions> => ({
      context,
      pi,
      options,
      runtime,
      signal,
    }));
    context.effect(() => () => lifecycle.dispose(), `${name}/lifecycle`);
    const tool = (item: PiToolContribution, executionSignal?: () => AbortSignal): void => {
      if ('kind' in item && item.kind === 'pi-tool') {
        item.register(pi, executionSignal);
        return;
      }
      if (!('kind' in item)) {
        if (!executionSignal) {
          pi.registerTool(item);
          return;
        }
        pi.registerTool({
          ...item,
          async execute(toolCallId, input, signal, update, context) {
            const current = executionSignal();
            current.throwIfAborted();
            return item.execute(
              toolCallId,
              input,
              signal ? AbortSignal.any([signal, current]) : current,
              update,
              context,
            );
          },
        });
        return;
      }
      pi.registerTool({
        ...item.pi,
        name: item.name,
        label: item.label ?? item.name,
        description: item.description,
        parameters: item.parameters,
        promptSnippet: item.promptSnippet,
        promptGuidelines: item.promptGuidelines ? [...item.promptGuidelines] : undefined,
        executionMode: item.executionMode === 'serial' ? 'sequential' : item.executionMode,
        async execute(toolCallId, input, signal, update, execution) {
          const current = executionSignal?.() ?? lifecycle.context.signal;
          current.throwIfAborted();
          const result = await item.execute(input, {
            toolCallId,
            cwd: execution.cwd,
            signal: signal ? AbortSignal.any([signal, current]) : current,
            update: (result) => update?.({ ...result, details: result.details }),
            notify: (request) => {
              if (execution.hasUI) execution.ui.notify(request.body, request.level ?? 'info');
            },
          });
          return { ...result, details: result.details };
        },
      });
    };
    await lifecycle.mount(
      () => (typeof definition === 'string' ? factory!(lifecycle.context) : definition),
      async (contributions) => {
        for (const service of contributions.services ?? []) {
          const fiber = context.plugin(service);
          lifecycle.own(() => fiber.dispose());
          await fiber;
        }
        const tools = contributions.tools;
        if (tools && 'snapshot' in tools) {
          const registered = new Map<string, { readonly declaration: PiToolContribution; active?: AbortController }>();
          let disposed = false;
          let subscribing = true;
          let reconciling = false;
          let pending = false;
          const deactivate = (): void => {
            for (const entry of registered.values()) {
              entry.active?.abort();
              entry.active = undefined;
            }
          };
          lifecycle.own(() => {
            disposed = true;
            deactivate();
          });
          const reconcile = (): void => {
            pending = true;
            if (disposed || lifecycle.context.signal.aborted) {
              deactivate();
              return;
            }
            if (reconciling || subscribing) return;
            reconciling = true;
            try {
              do {
                pending = false;
                const snapshot = tools.snapshot();
                const names = new Map<string, PiToolContribution>();
                for (const declaration of snapshot) {
                  if (names.has(declaration.name)) throw new Error(`Duplicate live tool name: ${declaration.name}`);
                  names.set(declaration.name, declaration);
                }
                for (const [name, entry] of registered) {
                  if (names.get(name) !== entry.declaration) {
                    entry.active?.abort();
                    entry.active = undefined;
                  }
                }
                for (const declaration of snapshot) {
                  let entry = registered.get(declaration.name);
                  if (entry && entry.declaration !== declaration) entry = undefined;
                  if (entry) {
                    entry.active ??= new AbortController();
                    continue;
                  }
                  entry = { declaration, active: new AbortController() };
                  const current = entry;
                  registered.set(declaration.name, entry);
                  try {
                    tool(declaration, () => {
                      lifecycle.context.signal.throwIfAborted();
                      if (!current.active || disposed)
                        throw new Error(`Tool ${declaration.name} is unavailable in this plugin generation.`);
                      return AbortSignal.any([lifecycle.context.signal, current.active.signal]);
                    });
                  } catch (error) {
                    registered.delete(declaration.name);
                    throw error;
                  }
                }
              } while (pending && !disposed);
            } catch (error) {
              deactivate();
              throw error;
            } finally {
              reconciling = false;
            }
          };
          const unsubscribe = tools.subscribe(() => {
            try {
              reconcile();
            } catch {
              /* An invalid update leaves registered tools unavailable. */
            }
          });
          lifecycle.own(() => {
            disposed = true;
            deactivate();
            unsubscribe();
          });
          subscribing = false;
          reconcile();
        } else {
          for (const item of tools ?? []) tool(item);
        }
        for (const item of contributions.commands ?? []) {
          if (!('kind' in item)) {
            pi.registerCommand(...item);
            continue;
          }
          pi.registerCommand(item.name, {
            description: item.description,
            async handler(args, execution) {
              lifecycle.context.signal.throwIfAborted();
              await item.execute(args, {
                cwd: execution.cwd,
                signal: lifecycle.context.signal,
                notify: (request) => {
                  if (execution.hasUI) execution.ui.notify(request.body, request.level ?? 'info');
                },
              });
            },
          });
        }
        // The public mapped handlers retain each native event's input and return type.
        const on = pi.on.bind(pi) as (event: string, handler: unknown) => void;
        for (const [event, handler] of Object.entries(contributions.events ?? {})) on(event, handler);
        for (const item of contributions.providers ?? []) pi.registerProvider(...item);
        for (const item of contributions.messageRenderers ?? []) pi.registerMessageRenderer(...item);
        for (const item of contributions.entryRenderers ?? []) pi.registerEntryRenderer(...item);
        for (const item of contributions.markdownTransformers ?? []) pi.registerMarkdownTransformer(item);
        for (const item of contributions.shortcuts ?? []) pi.registerShortcut(...item);
        for (const item of contributions.flags ?? []) pi.registerFlag(...item);
        const bind = (service: string, register: (child: Context) => void): void => {
          const fiber = context.inject([service], register);
          lifecycle.own(() => fiber.dispose());
        };
        if (contributions.resources?.length)
          bind(DOOM_HELP_SERVICE, (child) => {
            for (const resource of contributions.resources!) {
              const handle = requireDoomHelpService(child).register(resource);
              child.effect(() => () => handle.dispose());
            }
          });
        if (contributions.toolRestrictions?.length)
          bind(DOOM_TOOL_SURFACE_SERVICE, (child) => {
            for (const restriction of contributions.toolRestrictions!) {
              const handle = requireDoomToolSurface(child).register(restriction);
              child.effect(() => () => handle.dispose());
              const unsubscribe = restriction.subscribe?.(() => handle.update(restriction.restrict));
              if (unsubscribe) child.effect(() => unsubscribe);
            }
          });
        if (contributions.toolOverrides?.length)
          bind(DOOM_TOOL_OVERRIDES_SERVICE, (child) => {
            for (const override of contributions.toolOverrides!) {
              const handle = requireDoomToolOverrides(child).claim(override);
              child.effect(() => () => handle.dispose());
              if (handle.granted) for (const replacement of override.replacements) tool(replacement);
            }
          });
      },
    );
  };
  const activate = async (pi: ExtensionAPI, options?: TOptions): Promise<void> => {
    const connection = await connectDoomCordisHost(pi, name);
    const fiber = connection.root.plugin(async (context) => {
      await install(context, pi, options, connection.runtime);
    });
    let completion: Promise<void> | undefined;
    const dispose = (): Promise<void> =>
      (completion ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })());
    try {
      await fiber;
      pi.on('session_shutdown', dispose);
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${name} startup and cleanup failed.`);
      }
      throw error;
    }
  };
  return Object.assign(activate, { install });
}

/**
 * What a CLI tool's presentation file supplies.
 *
 * The terminal is a frontend. `renderCall` and `renderResult` draw a tool call
 * into the TUI exactly as a cockpit tool renderer draws it into the browser,
 * so they are authored on the frontend side under a `.cli` platform suffix and
 * never alongside the tool's `execute`.
 */
export type PiToolRenderers<TParameters extends TSchema = TSchema, TDetails = unknown, TState = unknown> = Pick<
  ToolDefinition<TParameters, TDetails, TState>,
  'renderShell' | 'renderCall' | 'renderResult'
>;

/** A terminal renderer declaration or a factory resolved from its session mount. */
export type PiToolRendererFile<
  TContext = unknown,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
> =
  | PiToolRenderers<TParameters, TDetails, TState>
  | ((context: TContext) => PiToolRenderers<TParameters, TDetails, TState>);
/**
 * `(frontend)/tool/<name>.cli.tsx`. The filename names the tool these draw.
 *
 * Generic over the tool's schema, because a renderer reads the call it is
 * drawing: state the parameter type and `renderResult` sees the real arguments
 * instead of `unknown`, which is what the single-file version got for free.
 */
export function definePiToolRenderer<TParameters extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
  file: PiToolRenderers<TParameters, TDetails, TState>,
): PiToolRenderers<TParameters, TDetails, TState> {
  return file;
}

/** `(frontend)/tool/<name>.cli.tsx` when the renderer needs mount context. */
export function defineCliToolRenderer<
  TContext,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  file: PiToolRendererFile<TContext, TParameters, TDetails, TState>,
): PiToolRendererFile<TContext, TParameters, TDetails, TState> {
  return file;
}

/**
 * `(frontend)/message/<name>.cli.tsx`. A renderer for one custom message type.
 *
 * The type is stated rather than derived from the filename, because it is a
 * protocol constant shared with whatever emits the message. A path-derived
 * name would silently stop matching the moment either side was renamed.
 */
export function defineMessageRenderer(
  messageType: Parameters<ExtensionAPI['registerMessageRenderer']>[0],
  render: Parameters<ExtensionAPI['registerMessageRenderer']>[1],
): readonly [...Parameters<ExtensionAPI['registerMessageRenderer']>] {
  return [messageType, render];
}

/**
 * Attaches a presentation file's renderers to the tool its filename names.
 *
 * Three tool shapes reach a contribution array and each carries renderers in a
 * different place, so a generated entry cannot spell this merge itself. A
 * native Pi definition takes them at the top level, the portable shape nests
 * them under `pi`, and `definePiTool` owns its own registration, so that one
 * is reached by narrowing the host it registers against. `register` asks for
 * nothing but `registerTool`, which is what makes the last case a two-line
 * shim rather than a proxy over the whole extension API.
 */
export function withPiRenderers(tool: PiToolContribution, renderers: PiToolRenderers): PiToolContribution {
  if (!('kind' in tool)) return { ...tool, ...renderers };
  if (tool.kind !== 'pi-tool') return { ...tool, pi: { ...tool.pi, ...renderers } };
  return {
    ...tool,
    register(pi, executionSignal) {
      tool.register(
        { registerTool: (definition) => pi.registerTool({ ...definition, ...renderers }) },
        executionSignal,
      );
    },
  };
}

/**
 * Splits routed tool files into the two arrays the Pi host keeps apart.
 *
 * A tool that replaces a name Pi already ships is not a second registration,
 * it is a claim the override service arbitrates, and only the winner
 * registers. The folder convention keeps both in `tool/`, because from the
 * author's side both are "this package provides grep"; which one it is lives
 * in the value, through `definePiTool(definition, { overrides: true })`.
 *
 * A generated entry therefore cannot decide this from the path, and calls
 * this instead. Every static claim from one package is one atomic set, which
 * is what the override service expects. A live collection stays intact so its
 * subscription continues to drive registration changes.
 */
export function piToolContributions(
  source: string,
  items: readonly PiToolContribution[] | PiToolCollection,
): Pick<PiPluginContributions, 'tools' | 'toolOverrides'> {
  if (!Array.isArray(items)) return { tools: items as PiToolCollection };
  const added: PiToolContribution[] = [];
  const claimed: PiToolDeclaration[] = [];
  for (const item of items) {
    // Only a native declaration may claim a name: a replacement is handed to
    // Pi's registry directly, which the portable shape is not.
    if ('kind' in item && item.kind === 'pi-tool' && item.overrides === true) claimed.push(item);
    else added.push(item);
  }
  if (claimed.length === 0) return { tools: added };
  return {
    tools: added,
    toolOverrides: [{ source, tools: claimed.map((item) => item.name), replacements: claimed }],
  };
}
