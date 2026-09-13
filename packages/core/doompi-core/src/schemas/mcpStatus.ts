import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';

/** Session-scoped MCP status service owned by doompi-mcp. */
export const DOOM_MCP_STATUS_SERVICE = 'doom/mcp-status';

/**
 * Connection state of one downstream MCP server.
 *
 * `not-connected` is the startup state: tools restored from the previous run's
 * catalog exist before any socket opens, and their server has not reported yet.
 * `disabled` comes from configuration rather than the connection stream, since a
 * disabled server is never dialled at all.
 */
export const McpServerStateSchema = Type.Union([
  Type.Literal('not-connected'),
  Type.Literal('connecting'),
  Type.Literal('connected'),
  Type.Literal('degraded'),
  Type.Literal('needs-auth'),
  Type.Literal('failed'),
  Type.Literal('closed'),
  Type.Literal('disabled'),
]);
export type McpServerState = Static<typeof McpServerStateSchema>;

export const McpServerSnapshotSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    state: McpServerStateSchema,
    /**
     * Pi tool names registered for this server, exactly as registered.
     *
     * Published rather than derived: a consumer that reverse-engineers the link from
     * tool-name prefixes cannot attribute anything under an unprefixed naming scheme,
     * and guesses wrong whenever two servers share a prefix.
     */
    tools: Type.Array(Type.String({ minLength: 1 })),
    resourceCount: Type.Integer({ minimum: 0 }),
    /** Why the server is in `failed` or `needs-auth`; absent otherwise. */
    error: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type McpServerSnapshot = Static<typeof McpServerSnapshotSchema>;

export const McpStatusSnapshotSchema = Type.Object(
  { servers: Type.Array(McpServerSnapshotSchema) },
  { additionalProperties: false },
);
export type McpStatusSnapshot = Static<typeof McpStatusSnapshotSchema>;

/**
 * The current MCP picture, with optional live change notifications.
 *
 * Consumers subscribe before reading the snapshot so startup ordering cannot
 * lose a change. Older providers remain readable through getSnapshot alone.
 *
 * No provider means MCP is not loaded for this session (`--no-mcp`), which times
 * out and is not an error.
 */
export interface DoomMcpStatusService {
  /** Fences consumers against a replaced MCP session. */
  readonly generation: string;
  getSnapshot(): McpStatusSnapshot;
  /** Notifies after tool registration and status updates; returns listener cleanup. */
  onChange?(listener: () => void): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/mcp-status': DoomMcpStatusService;
  }
}

export function readDoomMcpStatus(context: Context): DoomMcpStatusService | undefined {
  return context.get(DOOM_MCP_STATUS_SERVICE) as DoomMcpStatusService | undefined;
}
