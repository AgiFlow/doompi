import type { PiToolDeclaration } from '../schemas/piTool';
import { createPluginLifecycle, type PluginLifecycleHooks } from '../services/pluginLifecycle';
import type { DoomPluginTool, DoomPluginCommand } from '../schemas/pluginContributions';
import type { MinorModeOwner } from '../schemas/minorModeFactory';
import type { DoomToolRestrictionDefinition } from '../schemas/toolSurface';

import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { connectDoomCordisHost, type DoomCordisRuntimeService } from './cordisHost';
import { DOOM_HELP_SERVICE, requireDoomHelpService, type DoomHelpService } from '../schemas/help';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  requireMinorModeCatalog,
  type MinorModeOwnerActionContext,
  type MinorModeOwnerDefinition,
  type MinorModeOwnerHandle,
} from '../schemas/mode';
import { registerMinorModeOwner } from '../schemas/modeOwner';
import { DOOM_TOOL_SURFACE_SERVICE, requireDoomToolSurface } from '../schemas/toolSurface';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  requireDoomToolOverrides,
  type DoomToolOverrideClaim,
} from '../schemas/toolOverrides';

type ModeRegistrar = (definition: MinorModeOwnerDefinition<ExtensionContext>) => MinorModeOwnerHandle;

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

export type PiMinorModeContribution =
  | MinorModeOwner<MinorModeOwnerActionContext<ExtensionContext>>
  | Parameters<ModeRegistrar>[0];
export interface PiMinorModeCollection {
  snapshot(): readonly PiMinorModeContribution[];
  subscribe(listener: () => void): () => void;
}

export interface PiPluginContributions<TOptions = undefined> extends PluginLifecycleHooks<PiPluginContext<TOptions>> {
  readonly services?: readonly Parameters<Context['plugin']>[0][];
  readonly tools?: readonly PiToolContribution[] | PiToolCollection;
  readonly commands?: readonly (DoomPluginCommand | readonly [...Parameters<ExtensionAPI['registerCommand']>])[];
  readonly events?: PiEventHandlers;
  readonly resources?: readonly Parameters<DoomHelpService['register']>[0][];
  readonly minorModes?: readonly PiMinorModeContribution[] | PiMinorModeCollection;
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
        if (contributions.minorModes)
          bind(DOOM_MINOR_MODE_CATALOG_SERVICE, (child) => {
            const modes = contributions.minorModes!;
            const catalog = requireMinorModeCatalog(child);
            const mounted = new Map<string, { declaration: PiMinorModeContribution; release(): void }>();
            let disposed = false;
            let reconciling = false;
            let pending = false;
            let subscribing = true;
            const reconcile = (): void => {
              pending = true;
              if (disposed || lifecycle.context.signal.aborted || subscribing || reconciling) return;
              reconciling = true;
              try {
                do {
                  pending = false;
                  const snapshot = 'snapshot' in modes ? modes.snapshot() : modes;
                  const next = new Map<string, PiMinorModeContribution>();
                  for (const declaration of snapshot) {
                    const definition = 'definition' in declaration ? declaration.definition : declaration;
                    const key = JSON.stringify([definition.descriptor.source, definition.descriptor.id]);
                    if (next.has(key))
                      throw new Error(
                        `Duplicate live minor mode: ${definition.descriptor.source}/${definition.descriptor.id}`,
                      );
                    next.set(key, declaration);
                  }
                  for (const [key, entry] of mounted) {
                    if (next.get(key) === entry.declaration) continue;
                    mounted.delete(key);
                    entry.release();
                  }
                  for (const [key, declaration] of next) {
                    if (mounted.has(key)) continue;
                    const owner = 'definition' in declaration ? declaration : undefined;
                    const handle = registerMinorModeOwner(
                      catalog,
                      owner ? owner.definition : (declaration as Parameters<ModeRegistrar>[0]),
                    );
                    mounted.set(key, {
                      declaration,
                      release() {
                        try {
                          owner?.detach();
                        } finally {
                          handle.dispose();
                        }
                      },
                    });
                    owner?.attach(handle);
                  }
                } while (pending && !disposed && !lifecycle.context.signal.aborted);
              } finally {
                reconciling = false;
              }
            };
            child.effect(() => () => {
              disposed = true;
              const entries = [...mounted.values()];
              mounted.clear();
              const errors: unknown[] = [];
              for (const entry of entries) {
                try {
                  entry.release();
                } catch (error) {
                  errors.push(error);
                }
              }
              if (errors.length) throw new AggregateError(errors, 'Minor mode cleanup failed.');
            });
            if ('subscribe' in modes) {
              const unsubscribe = modes.subscribe(reconcile);
              child.effect(() => () => {
                disposed = true;
                unsubscribe();
              });
            }
            subscribing = false;
            reconcile();
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
