import { Button } from '@agimon-ai/doompi-web-components';
import type { SessionFrameSender, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { MCP_SESSION_AUTH_STATUS_KEY, parseMcpSessionAuthStatus } from '../types/webMcp.ts';

/** Requests authorization through Pi's command frame, never through a browser shell or URL opener. */
export function requestMcpSessionAuthorization(
  sendSessionFrame: SessionFrameSender,
  sessionId: string,
  serverName: string,
): void {
  sendSessionFrame(sessionId, { type: 'prompt', message: `/mcp auth ${serverName}` });
}

/** Live MCP servers waiting for authorization in the focused session. */
export function McpSessionAuthSection({ sessionId, statuses, sendSessionFrame }: WebPluginSlotProps) {
  const servers = parseMcpSessionAuthStatus(statuses[MCP_SESSION_AUTH_STATUS_KEY]);
  if (!servers) return null;

  return (
    <section data-testid="context-mcp-auth" className="flex flex-col gap-2 border-b border-doom-border px-3 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-[9px] font-bold uppercase tracking-wide text-doom-faint">MCP authorization</p>
        <p className="text-[9px] leading-relaxed text-doom-muted">
          Authorization links appear in the session transcript.
        </p>
      </div>
      <ul aria-label="MCP servers needing authorization" className="flex flex-col gap-1">
        {servers.map((server) => (
          <li key={server.name} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
            <span className="min-w-0 flex-1 truncate text-[10px] text-doom-hi">{server.name}</span>
            <Button
              variant="subtle"
              size="xs"
              data-testid={`context-mcp-auth-${server.name}`}
              aria-label={`Authorize ${server.name}`}
              disabled={sessionId === null}
              onClick={() => {
                if (sessionId !== null) requestMcpSessionAuthorization(sendSessionFrame, sessionId, server.name);
              }}
              className="shrink-0 text-[8px] font-bold"
            >
              authorize
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
