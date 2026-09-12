import { defineService, type Context, type JsonValue } from '@earendil-works/chord';
import { type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import type { DoomApiMount, DoomApiScope } from './packageApi';

/** The address is always exact. A workspace call never resolves to a global service. */
export const DoomPluginMountSchema = Type.Union([
  Type.Object({ scope: Type.Literal('global') }, { additionalProperties: false }),
  Type.Object(
    { scope: Type.Literal('workspace'), workspaceId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { scope: Type.Literal('session'), sessionId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export const DoomPluginCallSchema = Type.Object(
  {
    mount: DoomPluginMountSchema,
    service: Type.String({ minLength: 1 }),
    method: Type.String({ minLength: 1 }),
    input: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type DoomPluginCall = Static<typeof DoomPluginCallSchema>;
export type DoomPluginDirection = 'client-to-server' | 'server-to-client';
export interface DoomPluginCaller {
  /** Authenticated connection that owns client capabilities and leases. */
  connectionId?: string;
}

/** Chord method shared by all authenticated Doompi clients. */
export interface DoomPluginService {
  invoke(
    call: {
      mount: DoomApiMount;
      service: string;
      method: string;
      input: JsonValue;
    },
    context: Context,
  ): Promise<JsonValue>;
}

export const DoomPluginService = defineService<DoomPluginService>('doompi.plugin.v1');

export interface DoomPluginMethod<TInput extends TSchema, TOutput extends TSchema> {
  readonly service: string;
  readonly method: string;
  readonly scope: DoomApiScope;
  readonly direction: DoomPluginDirection;
  readonly input: TInput;
  readonly output: TOutput;
}

export function defineDoomPluginMethod<TInput extends TSchema, TOutput extends TSchema>(
  definition: DoomPluginMethod<TInput, TOutput>,
): DoomPluginMethod<TInput, TOutput> {
  if (!definition.service || !definition.method) throw new Error('Plugin service and method must be named.');
  return definition;
}

export function doomPluginMountKey(mount: DoomApiMount): string {
  if (!Check(DoomPluginMountSchema, mount)) throw new Error('Invalid plugin mount.');
  switch (mount.scope) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${mount.workspaceId}`;
    case 'session':
      return `session:${mount.sessionId}`;
  }
}

export class DoomPluginCallError extends Error {
  constructor(
    readonly code: 'INVALID_CALL' | 'METHOD_NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'DoomPluginCallError';
  }
}

export interface DoomPluginRegistry {
  register<TInput extends TSchema, TOutput extends TSchema>(
    mount: DoomApiMount,
    definition: DoomPluginMethod<TInput, TOutput>,
    handler: (input: Static<TInput>, caller: DoomPluginCaller) => Static<TOutput> | Promise<Static<TOutput>>,
  ): () => void;
  invoke(call: unknown, direction: DoomPluginDirection, caller?: DoomPluginCaller): Promise<unknown>;
  dispose(): void;
}

/** Transport-neutral dispatch, shared by Chord server services and client capability hosts. */
export function createDoomPluginRegistry(): DoomPluginRegistry {
  const handlers = new Map<
    string,
    {
      definition: DoomPluginMethod<TSchema, TSchema>;
      handler: (input: never, caller: DoomPluginCaller) => unknown;
    }
  >();
  let disposed = false;
  const keyOf = (mount: DoomApiMount, service: string, method: string, direction: DoomPluginDirection): string =>
    `${doomPluginMountKey(mount)}\0${direction}\0${service}\0${method}`;
  return {
    register(mount, definition, handler) {
      if (disposed) throw new Error('Plugin registry is disposed.');
      if (mount.scope !== definition.scope)
        throw new Error(`Method '${definition.service}.${definition.method}' requires ${definition.scope} scope.`);
      const key = keyOf(mount, definition.service, definition.method, definition.direction);
      if (handlers.has(key))
        throw new Error(`Plugin method '${definition.service}.${definition.method}' is already mounted.`);
      const entry = { definition, handler } as typeof handlers extends Map<string, infer TValue> ? TValue : never;
      handlers.set(key, entry);
      return () => {
        if (handlers.get(key) === entry) handlers.delete(key);
      };
    },
    async invoke(value, direction, caller = {}) {
      if (disposed) throw new Error('Plugin registry is disposed.');
      if (!Check(DoomPluginCallSchema, value)) throw new DoomPluginCallError('INVALID_CALL', 'Invalid plugin call.');
      const call = value as DoomPluginCall;
      const entry = handlers.get(keyOf(call.mount, call.service, call.method, direction));
      if (!entry)
        throw new DoomPluginCallError(
          'METHOD_NOT_FOUND',
          `Plugin method '${call.service}.${call.method}' is not mounted at this scope.`,
        );
      if (!Check(entry.definition.input, call.input))
        throw new DoomPluginCallError('INVALID_INPUT', `Invalid input for '${call.service}.${call.method}'.`);
      const output = await entry.handler(call.input as never, caller);
      if (!Check(entry.definition.output, output))
        throw new DoomPluginCallError('INVALID_OUTPUT', `Invalid output from '${call.service}.${call.method}'.`);
      return output;
    },
    dispose() {
      disposed = true;
      handlers.clear();
    },
  };
}

export async function invokeDoomPluginMethod<TInput extends TSchema, TOutput extends TSchema>(
  transport: (call: DoomPluginCall) => Promise<unknown>,
  mount: DoomApiMount,
  definition: DoomPluginMethod<TInput, TOutput>,
  input: Static<TInput>,
): Promise<Static<TOutput>> {
  if (mount.scope !== definition.scope)
    throw new Error(`Method '${definition.service}.${definition.method}' requires ${definition.scope} scope.`);
  if (!Check(definition.input, input))
    throw new DoomPluginCallError('INVALID_INPUT', `Invalid input for '${definition.service}.${definition.method}'.`);
  const output = await transport({ mount, service: definition.service, method: definition.method, input });
  if (!Check(definition.output, output))
    throw new DoomPluginCallError(
      'INVALID_OUTPUT',
      `Invalid output from '${definition.service}.${definition.method}'.`,
    );
  return output;
}
