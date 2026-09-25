import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The MCP host supplies invocation data. Widgets never receive host services or credentials. */
export interface DoomMcpWidgetProps {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: CallToolResult | null;
  readonly phase: 'connecting' | 'preparing' | 'running' | 'result' | 'cancelled' | 'error';
  readonly error?: string;
  /** Only available when this tool explicitly allows app calls and the host supports them. */
  readonly refresh?: () => Promise<CallToolResult>;
}
