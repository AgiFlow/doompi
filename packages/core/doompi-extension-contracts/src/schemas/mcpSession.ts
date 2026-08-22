import { type Static, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { type DoomMcpProjectionSource, DoomMcpProjectionSourceSchema } from './mcpProjection.ts';

/** Environment variable carrying the neutral MCP session wire document. */
export const DOOM_MCP_SESSION_ENV_VAR = 'DOOM_MCP_SESSION';

export const DoomMcpSessionAllowlistSchema = Type.Object(
  {
    servers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    proxy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);
export type DoomMcpSessionAllowlist = Static<typeof DoomMcpSessionAllowlistSchema>;

export interface DoomMcpSessionConfig {
  enabled?: boolean;
  repoRoot: string;
  stagingDirectory: string;
  generatedConfigPath?: string;
  pluginConfigPaths?: string[];
  sources?: readonly DoomMcpProjectionSource[];
  allowlist?: DoomMcpSessionAllowlist;
}

export const DoomMcpSessionConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    repoRoot: Type.String({ minLength: 1 }),
    stagingDirectory: Type.String({ minLength: 1 }),
    generatedConfigPath: Type.Optional(Type.String({ minLength: 1 })),
    pluginConfigPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    sources: Type.Optional(Type.Array(DoomMcpProjectionSourceSchema)),
    allowlist: Type.Optional(DoomMcpSessionAllowlistSchema),
  },
  { additionalProperties: false },
);

function sessionConfigError(value: unknown): Error {
  const [first] = Errors(DoomMcpSessionConfigSchema, value);
  return new Error(
    `Invalid Doom MCP session config${first ? ` at ${first.instancePath || '/'}: ${first.message}` : ''}`,
  );
}

/** Serializes one validated session document for a child process boundary. */
export function serializeDoomMcpSessionConfig(config: DoomMcpSessionConfig): string {
  if (!Check(DoomMcpSessionConfigSchema, config)) throw sessionConfigError(config);
  return JSON.stringify(config);
}

/** Parses a session wire document. Invalid input resolves to the fail-closed absence state. */
export function parseDoomMcpSessionConfig(value: string): DoomMcpSessionConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return Check(DoomMcpSessionConfigSchema, parsed) ? parsed : undefined;
}

/** Reads a session document without adding feature-specific fallback policy. */
export function readDoomMcpSessionConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DoomMcpSessionConfig | undefined {
  const value = environment[DOOM_MCP_SESSION_ENV_VAR];
  return value === undefined ? undefined : parseDoomMcpSessionConfig(value);
}

/** Builds the environment fragment inherited by an MCP-enabled child process. */
export function doomMcpSessionEnvironment(config: DoomMcpSessionConfig): Record<string, string> {
  return { [DOOM_MCP_SESSION_ENV_VAR]: serializeDoomMcpSessionConfig(config) };
}
