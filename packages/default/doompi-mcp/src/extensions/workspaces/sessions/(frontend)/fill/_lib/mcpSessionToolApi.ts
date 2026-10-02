import { mcpSession } from '../../../../../../../generated/client';
import {
  MCP_SESSION_TOOL_NAME_QUERY,
  MCP_SESSION_TOOL_SERVER_QUERY,
  type McpSessionToolDetail,
} from '../../../../../../types/webMcp';

export type FetchSessionToolResult = { ok: true; detail: McpSessionToolDetail } | { ok: false; error: string };

/** One available session tool: its registered name, description, schema and token estimate. */
export async function fetchSessionTool(
  sessionId: string,
  server: string,
  tool: string,
): Promise<FetchSessionToolResult> {
  const result = await mcpSession
    .session(sessionId)
    .sessionTool({ query: { [MCP_SESSION_TOOL_SERVER_QUERY]: server, [MCP_SESSION_TOOL_NAME_QUERY]: tool } });
  if (!result.ok) {
    if (result.status === 0) return { ok: false, error: 'The session is unreachable.' };
    return { ok: false, error: result.error === '' ? `The session answered ${result.status}.` : result.error };
  }
  return { ok: true, detail: result.data };
}
