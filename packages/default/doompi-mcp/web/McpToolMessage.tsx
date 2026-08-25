import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import type { McpResultBlock } from '../src/types/webMcp.ts';
import {
  type McpStatusTone,
  matchMcpTool,
  mcpArgumentSummary,
  mcpIdentityFromDetails,
  mcpImageBlocks,
  mcpResultBlocks,
  mcpResultView,
} from './mcpToolMatch.ts';

const STATUS_TONE: Record<McpStatusTone, StatusTone> = {
  running: 'running',
  ok: 'ok',
  error: 'error',
  hint: 'neutral',
};

/** The Pi name split on its first underscore, for a call whose server the session has not named. */
function fallbackIdentity(toolName: string): { server: string; tool: string } {
  const separator = toolName.indexOf('_');
  if (separator <= 0) return { server: toolName, tool: '' };
  return { server: toolName.slice(0, separator), tool: toolName.slice(separator + 1) };
}

/** One block beyond text the result carried: a link, an embedded resource, structured content, or audio. */
function McpBlock({ block }: { block: McpResultBlock }) {
  switch (block.type) {
    case 'resource_link':
      return (
        <a
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          data-testid="tool-result-mcp-link"
          className="truncate text-doom-blue hover:underline"
          title={block.description ?? block.uri}
        >
          {block.title ?? block.name}
        </a>
      );
    case 'resource':
      return block.text !== undefined ? (
        <pre data-testid="tool-result-mcp-resource" className="whitespace-pre-wrap break-words text-doom-dim">
          {block.text}
        </pre>
      ) : (
        <span data-testid="tool-result-mcp-resource" className="truncate text-doom-faint">
          binary {block.mimeType ?? 'resource'} · {block.uri}
        </span>
      );
    case 'structured':
      return (
        <pre data-testid="tool-result-mcp-structured" className="whitespace-pre-wrap break-words text-doom-dim">
          {JSON.stringify(block.value, null, 2)}
        </pre>
      );
    case 'audio':
      return (
        <span data-testid="tool-result-mcp-audio" className="text-doom-faint">
          audio · {block.mimeType}
        </span>
      );
  }
}

/**
 * The MCP tool's timeline item, the web half of renderMcpCall and
 * renderMcpResult: `mcp | server / tool · k=v` in the header; the text lines,
 * collapsed to twelve, then the images Pi carries beside the text, the
 * blocks the adapter put in the details, and one status line in the body.
 */
export function McpToolMessage({ toolName, args, result, output, running, isError, statuses }: ToolMessageRenderProps) {
  const identity =
    mcpIdentityFromDetails(result?.details) ?? matchMcpTool(toolName, statuses) ?? fallbackIdentity(toolName);
  const summary = mcpArgumentSummary(args);
  const collapsed = mcpResultView({ output, expanded: false, isPartial: running, isError });
  const images = mcpImageBlocks(result?.content ?? []);
  const blocks = mcpResultBlocks(result?.details);

  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.status?.tone === 'hint'}>
      {({ expanded }) => {
        const view = expanded ? mcpResultView({ output, expanded: true, isPartial: running, isError }) : collapsed;
        const hint = view.status?.tone === 'hint';
        return (
          <>
            <MessageItemHeader title="mcp">
              <span data-testid="tool-call-mcp" className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 text-doom-dim">{identity.server}</span>
                <span className="shrink-0 text-doom-faint">/</span>
                <span className="shrink-0 text-doom-blue">{identity.tool}</span>
                {summary ? <span className="min-w-0 flex-1 truncate text-doom-faint">· {summary}</span> : null}
              </span>
            </MessageItemHeader>
            {view.lines.length > 0 || view.status !== null || images.length > 0 || blocks.length > 0 ? (
              <MessageItemBody
                data-testid="tool-result-mcp"
                data-mcp-server={identity.server}
                className="flex flex-col gap-1"
              >
                {view.lines.length > 0 ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-doom-dim">{view.lines.join('\n')}</pre>
                ) : null}
                {images.map((image, index) => (
                  <img
                    key={`${String(index)}-${image.mimeType}`}
                    data-testid="tool-result-mcp-image"
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`${identity.tool} result ${String(index + 1)}`}
                    className="max-h-60 max-w-full self-start rounded border border-doom-border-soft"
                  />
                ))}
                {blocks.map((block, index) => (
                  <McpBlock key={`${String(index)}-${block.type}`} block={block} />
                ))}
                {view.status ? (
                  <MessageItemStatus
                    data-testid="tool-result-mcp-status"
                    tone={STATUS_TONE[view.status.tone]}
                    glyph={view.status.glyph}
                    expands={hint}
                  >
                    {view.status.text}
                  </MessageItemStatus>
                ) : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}
