import type { TSchema } from 'typebox';

import type {
  ActivityFile,
  ChannelFile,
  CommandContribution,
  CommandFile,
  HookFile,
  MethodFile,
  RouteFile,
  ServerToolFile,
  ServiceFile,
  ToolContribution,
  ToolFile,
} from '../schemas/extensionFile';
import type { DoomHeadlessEventName } from '../schemas/headless';

/**
 * Identity helpers for folder-routed backend files, one per surface.
 *
 * A routed file's default export is its whole contract with the host, and
 * nothing else validates it: the generated entry merges the path's identity in
 * and hands the result to a contribution array, where an excess or misspelled
 * key is invisible. These make the shape checkable at the point it is written,
 * and give the factory form a typed context instead of an implicit any.
 *
 * Most return their argument unchanged, so the value is entirely in the
 * position they check and the inference they supply. The two that do not,
 * `defineTool` and `defineCommand`, add the discriminant the host reads to
 * tell a portable contribution from a raw host declaration.
 */

/** `tool/<name>.ts`. Adds the discriminant the contribution array expects. */
export function defineTool<TContext = unknown>(file: ToolFile<TContext>): ToolContribution<TContext> {
  return typeof file === 'function'
    ? (context) => ({ kind: 'tool' as const, ...file(context) })
    : { kind: 'tool' as const, ...file };
}

/** `tool/<name>.server.ts`. A native headless tool, handed to the host untouched. */
export function defineServerTool<TParameters extends TSchema = TSchema, TContext = unknown>(
  file: ServerToolFile<TParameters, TContext>,
): ServerToolFile<TParameters, TContext> {
  return file;
}

/** `command/<name>.ts`. Adds the discriminant the contribution array expects. */
export function defineCommand<TContext = unknown>(file: CommandFile<TContext>): CommandContribution<TContext> {
  return typeof file === 'function'
    ? (context) => ({ kind: 'command' as const, ...file(context) })
    : { kind: 'command' as const, ...file };
}

/** `hook/<event>.ts`. Name the event here too when the handler needs a precise payload. */
export function defineHook<TEvent extends DoomHeadlessEventName = DoomHeadlessEventName, TContext = unknown>(
  file: HookFile<TEvent, TContext>,
): HookFile<TEvent, TContext> {
  return file;
}

/** `service/<name>.ts`. Passed through untouched, because a Cordis plugin is itself a function. */
export function defineService(file: ServiceFile): ServiceFile {
  return file;
}

/** `channel/<frameType>.ts`. The contribution array holds factories, so this is one. */
export function defineChannel(file: ChannelFile): ChannelFile {
  return file;
}

/** `api/<segments>/route.ts`. The folder path is the route. */
export function defineRoute<TContext = unknown>(file: RouteFile<TContext>): RouteFile<TContext> {
  return file;
}

/** `method/<member>.ts`. Build the value with `defineServerMethod` to keep schema inference. */
export function defineMethod<TContext = unknown>(file: MethodFile<TContext>): MethodFile<TContext> {
  return file;
}

/** `activity/<name>.ts`. */
export function defineActivity<TContext = unknown>(file: ActivityFile<TContext>): ActivityFile<TContext> {
  return file;
}
