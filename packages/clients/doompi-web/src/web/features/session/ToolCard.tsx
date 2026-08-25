import {
  collapseLines,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
} from '@agimon-ai/doompi-web-components';
import { ToolRendererBoundary } from '../../components/ToolRendererBoundary.tsx';
import { pluginToolRenderer } from '../../lib/pluginRegistry.ts';
import type { ToolEntry } from '../../lib/sessionModel.ts';
import { toolMessageProps } from '../../lib/toolMessageProps.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps.ts';

const MAX_PREVIEW_LINES = 12;

function toneOf(entry: ToolEntry): StatusTone {
  return entry.running ? 'running' : entry.isError ? 'error' : 'ok';
}

/**
 * The host's own item for a tool no plugin claims: the argument summary in
 * the header and the result's text clipped until expanded, on the same shell
 * every plugin message is built from.
 */
function HostToolMessage({ entry }: { entry: ToolEntry }) {
  const lines = entry.output.length > 0 ? entry.output.split('\n') : [];
  return (
    <MessageItem tone={toneOf(entry)} expandable={lines.length > MAX_PREVIEW_LINES}>
      {({ expanded }) => {
        const { shown, hidden } = collapseLines(lines, MAX_PREVIEW_LINES, expanded);
        return (
          <>
            <MessageItemHeader title={entry.name}>
              <span className="min-w-0 flex-1 truncate">{entry.argSummary}</span>
            </MessageItemHeader>
            {shown.length > 0 ? (
              <MessageItemBody className="flex flex-col gap-1">
                <pre data-testid="tool-output" className="whitespace-pre-wrap break-words">
                  {shown.join('\n')}
                </pre>
                {hidden > 0 ? <MessageItemStatus expands>show {hidden} more line(s)</MessageItemStatus> : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}

/**
 * One tool call in the timeline. The plugin that registered the tool owns
 * the whole item through its `message` renderer, the web half of the TUI's
 * renderShell 'self'; the host only marks the row, catches a renderer that
 * throws, and stands in for a tool nobody claims.
 */
export function ToolCard({ entry, sessionId }: { entry: ToolEntry; sessionId: string | null }) {
  const statuses = useActiveSession((state) => state.statuses);
  const slotProps = usePluginSlotProps(sessionId);
  const renderer = pluginToolRenderer(entry.name, statuses);
  const state = toneOf(entry);
  const props = toolMessageProps(slotProps, entry, statuses);
  return (
    <ToolRendererBoundary key={entry.toolCallId} toolName={entry.name}>
      {(failed) => (
        <div
          data-testid="entry-tool"
          data-tool-name={entry.name}
          data-tool-state={state}
          data-tool-renderer={failed ? 'failed' : renderer ? 'plugin' : 'host'}
        >
          {renderer && !failed ? <renderer.message {...props} /> : <HostToolMessage entry={entry} />}
        </div>
      )}
    </ToolRendererBoundary>
  );
}
