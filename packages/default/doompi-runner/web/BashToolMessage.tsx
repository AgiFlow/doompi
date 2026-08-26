import {
  Button,
  FileIcon,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import {
  type BashStatusTone,
  bashResultDetails,
  bashResultView,
  formatBashCommand,
  formatBashFlags,
} from './bashToolFormat.ts';
import { runnerLogTab } from './RunnerLogPanel.tsx';
import { requestRunnerStop, runners } from './runnersStore.ts';

const STATUS_TONE: Record<BashStatusTone, StatusTone> = {
  running: 'running',
  ok: 'ok',
  error: 'error',
  background: 'info',
};

/**
 * The bash tool's timeline item, the web half of renderBashCall and
 * renderBashResult: the collapsed command and its modifiers in the header;
 * the streamed tail while running, then the bounded log tail with its
 * one-line summary in the body. A command promoted to a background runner
 * offers the same stop the activity dock does, for as long as the runners
 * channel reports it running.
 */
export function BashToolMessage({
  sessionId,
  args,
  result,
  output,
  running,
  isError,
  sendSessionFrame,
  openTransientTab,
}: ToolMessageRenderProps) {
  const details = bashResultDetails(result?.details);
  const runnerId = details.promoted === true ? details.id : undefined;
  // Every bash call is a runner and writes a log, promoted or not, so the log
  // control looks the run up by its own id; only stopping needs a promoted one.
  const run = useStore(runners.store, (state) =>
    details.id === undefined
      ? undefined
      : runners.select(state, sessionId).runs.find((entry) => entry.id === details.id),
  );
  const stopping = useStore(
    runners.store,
    (state) => runnerId !== undefined && runners.select(state, sessionId).stopRequested.includes(runnerId),
  );
  const command = typeof args.command === 'string' ? formatBashCommand(args.command) : '';
  const flags = formatBashFlags(args);
  const collapsed = bashResultView({ details: result?.details, output, expanded: false, isPartial: running, isError });
  const stoppable = sessionId !== null && runnerId !== undefined && run !== undefined && run.exit === undefined;

  return (
    <MessageItem
      tone={toolTone({ running, isError })}
      expandable={collapsed.hidden > 0 || details.logPath !== undefined}
    >
      {({ expanded }) => {
        const view = expanded
          ? bashResultView({ details: result?.details, output, expanded: true, isPartial: running, isError })
          : collapsed;
        return (
          <>
            <MessageItemHeader title="bash">
              <span data-testid="tool-call-bash" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-doom-text">{command}</span>
                {flags.length > 0 ? <span className="shrink-0 text-doom-faint">· {flags.join(' · ')}</span> : null}
              </span>
              {/* The card only ever shows a bounded tail, and expanding it
                  shows a longer bounded tail. The whole log is a click away
                  whether or not the card is open. */}
              {run !== undefined && sessionId !== null ? (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="tool-result-bash-open-log"
                  title="open this runner's full log"
                  onClick={(event) => {
                    event.stopPropagation();
                    openTransientTab(runnerLogTab(run));
                  }}
                  className="shrink-0 gap-1 px-1.5 text-[9px] font-bold"
                >
                  <FileIcon className="h-2.5 w-2.5" />
                  log
                </Button>
              ) : null}
            </MessageItemHeader>
            {view.lines.length > 0 || view.status !== null || stoppable ? (
              <MessageItemBody data-testid="tool-result-bash" className="flex flex-col gap-1">
                {view.lines.length > 0 ? (
                  <pre
                    className={`${expanded ? 'whitespace-pre-wrap break-words' : 'overflow-hidden whitespace-pre'} font-mono text-doom-dim`}
                  >
                    {view.lines.join('\n')}
                  </pre>
                ) : null}
                {view.status ? (
                  <MessageItemStatus
                    data-testid="tool-result-bash-status"
                    tone={STATUS_TONE[view.status.tone]}
                    glyph={view.status.glyph}
                  >
                    {view.status.text}
                    {view.hidden > 0 ? ` · ${String(view.hidden)} more line(s) above` : ''}
                  </MessageItemStatus>
                ) : null}
                {expanded && details.logPath !== undefined ? (
                  // The tail is bounded by the runner; the whole log only ever exists on
                  // disk, so the item names the file rather than pretending this is all.
                  <span data-testid="tool-result-bash-log" className="truncate text-doom-faint">
                    full log · <span className="text-doom-dim">{details.logPath}</span>
                  </span>
                ) : null}
                {stoppable ? (
                  <Button
                    size="xs"
                    variant={stopping ? 'outline' : 'danger-outline'}
                    disabled={stopping}
                    data-testid="tool-result-bash-stop"
                    data-stopping={stopping}
                    title={
                      stopping
                        ? 'stop requested; the runner reports its own exit'
                        : 'ask the runtime to stop this runner'
                    }
                    onClick={() => {
                      if (sessionId !== null && runnerId !== undefined)
                        requestRunnerStop(sendSessionFrame, sessionId, runnerId);
                    }}
                    className="self-start px-1.5 text-[8px] font-bold"
                  >
                    {stopping ? 'stopping…' : 'stop'}
                  </Button>
                ) : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}
