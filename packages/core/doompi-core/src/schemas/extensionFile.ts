import type { Context } from '@deepseek-ai/cordis';
import type { TSchema } from 'typebox';

import type { DoomHeadlessActivity, DoomHeadlessEventName, DoomHeadlessHook, DoomHeadlessTool } from './headless';
import type { DoomHubChannel } from './hubChannel';
import type { DoomApi } from './packageApi';
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

/** `command/<name>.ts`. The filename becomes the command name in snake case. */
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
 * `service/<name>.ts`. A Cordis plugin, exported bare.
 *
 * No factory form, and no derived identity. A Cordis plugin is itself a
 * function, so there is no runtime test that separates one from a
 * `(context) => declaration` factory. The generator passes this through
 * untouched for exactly that reason.
 */
export type ServiceFile = Parameters<Context['plugin']>[0];

/** `channel/<frameType>.ts`. The array holds factories, so this is one. */
export type ChannelFile = () => PathSupplied<DoomHubChannel, 'frameType'>;

/** `api/<segments>/route.ts`. The folder path is the route; nothing is derived into the value. */
export type RouteFile<TContext = unknown> = OrFactory<DoomApi, TContext>;

/** `method/<member>.ts`. Build it with `defineServerMethod` to keep schema inference. */
export type MethodFile<TContext = unknown> = OrFactory<DoomServerMethod, TContext>;

/** `activity/<name>.ts`. The filename is not derived into the value; activities name themselves. */
export type ActivityFile<TContext = unknown> = OrFactory<DoomHeadlessActivity, TContext>;
