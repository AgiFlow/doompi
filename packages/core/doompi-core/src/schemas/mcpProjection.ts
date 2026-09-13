import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Schema revision of the neutral MCP projection shared across DoomPi packages. */
export const DOOM_MCP_PROJECTION_VERSION = 1 as const;

/** The portable MCP document revision represented by `agent-plugin-v1`. */
export const AGENT_PLUGIN_MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' as const;

/** Cordis service name for the immutable MCP projection of one Pi session. */
export const DOOM_MCP_PROJECTION_SERVICE = 'doom/mcp-projection';

export const DoomMcpProjectionAllowlistSchema = Type.Object(
  {
    servers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    proxy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const DoomMcpNativeProjectionSourceSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1 }),
    owner: Type.Union([Type.Literal('repository'), Type.Literal('plugin')]),
    format: Type.Literal('native'),
    configPath: Type.String({ minLength: 1 }),
    contentDigest: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const DoomMcpAgentPluginProjectionSourceSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1 }),
    owner: Type.Literal('plugin'),
    format: Type.Literal('agent-plugin-v1'),
    configPath: Type.String({ minLength: 1 }),
    contentDigest: Type.String({ minLength: 1 }),
    pluginId: Type.String({ minLength: 1 }),
    pluginRoot: Type.String({ minLength: 1 }),
    pluginDataDirectory: Type.String({ minLength: 1 }),
    mcpSchemaUrl: Type.Literal(AGENT_PLUGIN_MCP_SCHEMA_URL),
  },
  { additionalProperties: false },
);

/** One native Doom layer or one portable Agent Plugin MCP document. */
export const DoomMcpProjectionSourceSchema = Type.Union([
  DoomMcpNativeProjectionSourceSchema,
  DoomMcpAgentPluginProjectionSourceSchema,
]);

export const DoomMcpProjectionSchema = Type.Object(
  {
    version: Type.Literal(DOOM_MCP_PROJECTION_VERSION),
    enabled: Type.Boolean(),
    /** Content identity supplied by the projection producer. */
    fingerprint: Type.String({ minLength: 1 }),
    repoRoot: Type.String({ minLength: 1 }),
    stagingDirectory: Type.String({ minLength: 1 }),
    generatedConfigPath: Type.Optional(Type.String({ minLength: 1 })),
    sources: Type.Array(DoomMcpProjectionSourceSchema),
    allowlist: Type.Optional(DoomMcpProjectionAllowlistSchema),
  },
  { additionalProperties: false },
);

type DeepReadonly<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
      : TValue;

export type DoomMcpProjectionAllowlist = DeepReadonly<Static<typeof DoomMcpProjectionAllowlistSchema>>;
export type DoomMcpNativeProjectionSource = DeepReadonly<Static<typeof DoomMcpNativeProjectionSourceSchema>>;
export type DoomMcpAgentPluginProjectionSource = DeepReadonly<Static<typeof DoomMcpAgentPluginProjectionSourceSchema>>;
export type DoomMcpProjectionSource = DeepReadonly<Static<typeof DoomMcpProjectionSourceSchema>>;
export type DoomMcpProjectionSourceFormat = DoomMcpProjectionSource['format'];
export type DoomMcpProjection = DeepReadonly<Static<typeof DoomMcpProjectionSchema>>;

export interface DoomMcpProjectionService {
  readonly sessionId: string;
  readonly generation: string;
  getSnapshot(): DoomMcpProjection;
}

export interface DoomMcpProjectionServiceInput {
  readonly sessionId: string;
  readonly generation: string;
  readonly projection: DoomMcpProjection;
}

export interface DisabledDoomMcpProjectionInput {
  readonly repoRoot: string;
  readonly stagingDirectory: string;
}

function deepFreeze<TValue>(value: TValue): DeepReadonly<TValue> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<TValue>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<TValue>;
}

function projectionError(value: unknown): Error {
  const [first] = Errors(DoomMcpProjectionSchema, value);
  return new Error(`Invalid Doom MCP projection${first ? ` at ${first.instancePath || '/'}: ${first.message}` : ''}`);
}

/** Runtime guard used when a projection crosses a JSON persistence boundary. */
export function isDoomMcpProjection(value: unknown): value is DoomMcpProjection {
  return Check(DoomMcpProjectionSchema, value);
}

/**
 * Builds the explicit fail-closed state used when a Doom session has no MCP
 * projection. The root and staging path remain visible for diagnostics, while
 * the empty source list prevents an MCP consumer from falling back to cwd.
 */
export function createDisabledDoomMcpProjection({
  repoRoot,
  stagingDirectory,
}: DisabledDoomMcpProjectionInput): DoomMcpProjection {
  return deepFreeze({
    version: DOOM_MCP_PROJECTION_VERSION,
    enabled: false,
    // Staging is per-process mutable state and must not change content identity
    // when a synced projection is rebased into a private run directory.
    fingerprint: JSON.stringify({ version: DOOM_MCP_PROJECTION_VERSION, enabled: false, repoRoot }),
    repoRoot,
    stagingDirectory,
    sources: [],
  });
}

/** Creates a generation-bound, immutable Cordis service value. */
export function createDoomMcpProjectionService({
  sessionId,
  generation,
  projection,
}: DoomMcpProjectionServiceInput): DoomMcpProjectionService {
  if (!sessionId) throw new Error('Doom MCP projection service requires a session id');
  if (!generation) throw new Error('Doom MCP projection service requires a generation');
  if (!isDoomMcpProjection(projection)) throw projectionError(projection);

  const snapshot = deepFreeze(structuredClone(projection)) as DoomMcpProjection;
  return Object.freeze({
    sessionId,
    generation,
    getSnapshot: () => snapshot,
  });
}

/** Reads the MCP projection provider from one Doom session's Cordis root. */
export function readDoomMcpProjectionService(root: Context): DoomMcpProjectionService | undefined {
  return root.get(DOOM_MCP_PROJECTION_SERVICE) as DoomMcpProjectionService | undefined;
}

/** Reads the MCP projection provider or reports that the Doom session is incomplete. */
export function requireDoomMcpProjectionService(root: Context): DoomMcpProjectionService {
  const service = readDoomMcpProjectionService(root);
  if (!service) throw new Error('Doom MCP projection is unavailable. Load the DoomPi Config core.');
  return service;
}
