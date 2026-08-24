import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  type McpStatusTone,
  matchMcpTool,
  mcpArgumentSummary,
  mcpIdentityFromDetails,
  mcpResultView,
} from './mcpToolMatch.ts';

const STATUS_TONE: Record<McpStatusTone, string> = {
  running: 'text-doom-yellow',
  ok: 'text-doom-green',
  error: 'text-doom-red',
  hint: 'text-doom-faint',
};

/** The Pi name split on its first underscore, for a call whose server the session has not named. */
function fallbackIdentity(toolName: string): { server: string; tool: string } {
  const separator = toolName.indexOf('_');
  if (separator <= 0) return { server: toolName, tool: '' };
  return { server: toolName.slice(0, separator), tool: toolName.slice(separator + 1) };
}

/**
 * The call half of an MCP card: `server / tool · k=v`, as renderMcpCall shows
 * it. The identity is the split the matcher made when it claimed the tool,
 * remade here from the same session statuses the card receives.
 */
export function McpCall({ toolName, args, statuses }: ToolCallRenderProps) {
  const identity = matchMcpTool(toolName, statuses) ?? fallbackIdentity(toolName);
  const summary = mcpArgumentSummary(args);
  return (
    <span data-testid="tool-call-mcp" className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="shrink-0 rounded-[3px] bg-doom-border-soft px-1 text-[9px] font-bold uppercase text-doom-dim">
        mcp
      </span>
      <span className="shrink-0 text-doom-dim">{identity.server}</span>
      <span className="shrink-0 text-doom-faint">/</span>
      <span className="shrink-0 text-doom-blue">{identity.tool}</span>
      {summary ? <span className="min-w-0 flex-1 truncate text-doom-faint">· {summary}</span> : null}
    </span>
  );
}

/** The result half: the text lines, collapsed to twelve, with the running, failed, done, or more-lines status. */
export function McpResult({ toolName, result, output, expanded, isPartial, isError, statuses }: ToolResultRenderProps) {
  const view = mcpResultView({ output, expanded, isPartial, isError });
  const identity = mcpIdentityFromDetails(result?.details) ?? matchMcpTool(toolName, statuses);
  return (
    <div data-testid="tool-result-mcp" data-mcp-server={identity?.server} className="flex flex-col gap-1">
      {view.lines.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-doom-dim">{view.lines.join('\n')}</pre>
      ) : null}
      {view.status ? (
        <span data-testid="tool-result-mcp-status" className="flex items-center gap-1.5 text-doom-faint">
          <span className={STATUS_TONE[view.status.tone]}>{view.status.glyph}</span>
          <span>{view.status.text}</span>
        </span>
      ) : null}
    </div>
  );
}
