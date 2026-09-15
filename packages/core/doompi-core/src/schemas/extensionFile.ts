import type { Context } from '@deepseek-ai/cordis';
import type { TSchema } from 'typebox';

import type { PluginLifecycleHooks } from '../services/pluginLifecycle';
import type { DoomHeadlessActivity, DoomHeadlessEventName, DoomHeadlessHook, DoomHeadlessTool } from './headless';
import type { DoomHubChannel } from './hubChannel';
import type { DoomApi } from './packageApi';
import type { PiToolDeclaration } from './piTool';
import type { DoomPluginCommand, DoomPluginTool } from './pluginContributions';
import type { DoomServerMethod } from './serverFacet';

/**
 * What a folder-routed file may export, per surface.
 *
 * A routed file declares one contribution and the path supplies its identity,
 * so these types are the host contract with the path-derived keys made
 * optional rather than removed. Optional is deliberate: the generator spreads
 * the authored value over the derived identity, so a file that states its own
 * name keeps it. Removing the key would make that legal-at-runtime case a type
 * error.
 *
 * Every surface also accepts a factory, because a contribution that needs the
 * mount context cannot be built at module scope. The one exception is
 * `service/`, whose export is itself a function.
 *
 * See docs/extension-layout.md for which folder produces which of these.
 */

/** The host contract with the keys a path derives made optional. */
export type PathSupplied<TContribution, TKeys extends keyof TContribution> = Omit<TContribution, TKeys> &
  Partial<Pick<TContribution, TKeys>>;

/** A declaration, or a factory the generator calls with the mount context. */
export type OrFactory<TDeclaration, TContext> = TDeclaration | ((context: TContext) => TDeclaration);

/**
 * `tool/<name>.ts`. The filename becomes the tool name in snake case.
 *
 * `kind` is absent because the helper adds it, which is also what keeps this
 * distinct from the neutral `defineTool` a hand-written entry uses.
 */
export type ToolFile<TContext = unknown> = OrFactory<PathSupplied<Omit<DoomPluginTool, 'kind'>, 'name'>, TContext>;

/** What `defineTool` returns: the authored shape with the discriminant restored. */
export type ToolContribution<TContext = unknown> = OrFactory<PathSupplied<DoomPluginTool, 'name'>, TContext>;

/**
 * `tool/<name>.server.ts`. A tool the headless host registers directly.
 *
 * Distinct from `ToolFile` on purpose. A portable tool carries `kind` and goes
 * through the host's adapter, which composes abort signals and turns a throw
 * into an error result. A native one is handed to the host untouched. Choosing
 * between them is a real decision, so it is spelled by the helper rather than
 * inferred from the shape.
 */
export type ServerToolFile<TParameters extends TSchema = TSchema, TContext = unknown> = OrFactory<
  PathSupplied<DoomHeadlessTool<TParameters>, 'name'>,
  TContext
>;

/**
 * What a scope's `root.ts` returns: the value its subtree shares, and the
 * lifetime hooks for that scope.
 *
 * `value` joins the mount context of every contribution beneath it, under
 * `root`. The hooks are the reason a root exists at all rather than a service:
 * `onStart` runs after the host has registered everything, which is the only
 * point at which it is safe to start work that can call back into a
 * contribution.
 */
export interface RootDeclaration<TValue, TContext = unknown> extends PluginLifecycleHooks<TContext> {
  readonly value: TValue;
}

/**
 * `root.ts`. One per scope and side, as Next.js spells a layout.
 *
 * Always a factory: a scope is constructed from its mount, and building the
 * graph at module scope is the module-level singleton the Cordis ownership
 * rules exist to prevent.
 */
export type RootFile<TValue, TContext = unknown> = (context: TContext) => RootDeclaration<TValue, TContext>;

/** A mount context with the nearest root's value attached, as a routed file sees it. */
export type WithRoot<TContext, TValue> = TContext & { readonly root: TValue };

/**
 * `tool/<name>.cli.ts`. A native interactive tool, handed to Pi untouched.
 *
 * The interactive counterpart of `ServerToolFile`. Pi's execute signature and
 * its registry are its own, so a tool that needs them is declared with
 * `definePiTool` rather than the portable shape; this is the factory form of
 * that, for a tool built from the mount rather than at module scope.
 */
export type CliToolFile<TContext = unknown> = OrFactory<PiToolDeclaration, TContext>;

/** `command/<name>.ts`. The filename becomes the command name in kebab case. */
export type CommandFile<TContext = unknown> = OrFactory<
  PathSupplied<Omit<DoomPluginCommand, 'kind'>, 'name'>,
  TContext
>;

/** What `defineCommand` returns: the authored shape with the discriminant restored. */
export type CommandContribution<TContext = unknown> = OrFactory<PathSupplied<DoomPluginCommand, 'name'>, TContext>;

/**
 * `hook/<event>.ts`. The filename becomes the event in snake case.
 *
 * Naming the event in the file as well is worth it when the handler needs a
 * precise payload: the event is the discriminant, so leaving it to the path
 * widens the handler's argument to every event's union.
 */
export type HookFile<TEvent extends DoomHeadlessEventName = DoomHeadlessEventName, TContext = unknown> = OrFactory<
  PathSupplied<DoomHeadlessHook<TEvent>, 'event'>,
  TContext
>;

/**
 * `service/<name>.ts`. A factory returning a Cordis plugin.
 *
 * Always a factory, never the plugin bare. A Cordis plugin is itself a
 * function, so no runtime test separates one from a `(context) => plugin`
 * factory; making the surface uniformly a factory removes the ambiguity
 * instead of guessing at it.
 *
 * It matters because this is how a package with shared per-mount state
 * decomposes. The factory receives the mount context, builds the graph the
 * package's tools, commands and hooks all read, and publishes it on the
 * Cordis context. Every other surface is emitted as a getter, so it is built
 * after the service fibers are up and can inject what this published.
 */
export type ServiceFile<TContext = unknown> = (context: TContext) => Parameters<Context['plugin']>[0];

/** `channel/<frameType>.ts`. The array holds factories, so this is one. */
export type ChannelFile = () => PathSupplied<DoomHubChannel, 'frameType'>;

/** `api/<segments>/route.ts`. The folder path is the route; nothing is derived into the value. */
export type RouteFile<TContext = unknown> = OrFactory<DoomApi, TContext>;

/** `method/<member>.ts`. Build it with `defineServerMethod` to keep schema inference. */
export type MethodFile<TContext = unknown> = OrFactory<DoomServerMethod, TContext>;

/** `activity/<name>.ts`. The filename is not derived into the value; activities name themselves. */
export type ActivityFile<TContext = unknown> = OrFactory<DoomHeadlessActivity, TContext>;
