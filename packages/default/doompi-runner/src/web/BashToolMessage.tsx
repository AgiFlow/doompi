import {
  AnsiText,
  Button,
  FileIcon,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
  SyntaxText,
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
 * renderBashResult. Collapsed it is a single header row: the tool name, the
 * command shortened to one line, its modifiers, and the outcome badge, so a
 * transcript of many calls stays scannable. Expanding it opens the body: the
 * command exactly as it was run, then the whole tail the frame carries, each
 * in its own scroll box so one chatty command cannot own the viewport. A
 * command promoted to a background runner offers the same stop the activity
 * dock does, for as long as the runners channel reports it running.
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
  const rawCommand = typeof args.command === 'string' ? args.command : '';
  const command = formatBashCommand(rawCommand);
  const flags = formatBashFlags(args);
  const stoppable = sessionId !== null && runnerId !== undefined && run !== undefined && run.exit === undefined;

  return (
    <MessageItem tone={toolTone({ running, isError })} expandable>
      {({ expanded }) => {
        // Nothing is shown until the card is open, so the body always reads the
        // unclipped view; the collapsed state has no lines to bound.
        const view = bashResultView({
          details: result?.details,
          output,
          expanded: true,
          isPartial: running,
          isError,
        });
        return (
          <>
            <MessageItemHeader title="bash">
              <span data-testid="tool-call-bash" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-doom-text">{command}</span>
                {flags.length > 0 ? (
                  <span className="hidden shrink-0 text-doom-faint sm:inline">· {flags.join(' · ')}</span>
                ) : null}
              </span>
              {/* The log and the stop live in the header, not the body: a
                  collapsed row still has to reach the whole log and still has
                  to be able to stop a run it promoted to the background. */}
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
              {stoppable ? (
                <Button
                  size="xs"
                  variant={stopping ? 'outline' : 'danger-outline'}
                  disabled={stopping}
                  data-testid="tool-result-bash-stop"
                  data-stopping={stopping}
                  title={
                    stopping ? 'stop requested; the runner reports its own exit' : 'ask the runtime to stop this runner'
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (sessionId !== null && runnerId !== undefined)
                      requestRunnerStop(sendSessionFrame, sessionId, runnerId);
                  }}
                  className="shrink-0 px-1.5 text-[9px] font-bold"
                >
                  {stopping ? 'stopping…' : 'stop'}
                </Button>
              ) : null}
            </MessageItemHeader>
            {expanded ? (
              <MessageItemBody data-testid="tool-result-bash" className="flex flex-col gap-2">
                {/* The header had to shorten the command to one row; this is
                    the command as it was actually run, wrapped rather than
                    clipped and coloured as the shell it is. */}
                {rawCommand.length > 0 ? (
                  <SyntaxText
                    data-testid="tool-result-bash-command"
                    grammar="shell"
                    text={rawCommand}
                    className="max-h-40 overflow-auto text-doom-text"
                  />
                ) : null}
                {/* The tail arrives with the colours the command wrote: the
                    log keeps them, and only the model's copy is flattened. */}
                {view.lines.length > 0 ? (
                  <AnsiText
                    data-testid="tool-result-bash-output"
                    text={view.lines.join('\n')}
                    className="max-h-96 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-doom-border-soft border-t pt-2 font-mono text-doom-dim"
                  />
                ) : null}
                {view.status ? (
                  <MessageItemStatus
                    data-testid="tool-result-bash-status"
                    tone={STATUS_TONE[view.status.tone]}
                    glyph={view.status.glyph}
                    className="min-w-0"
                  >
                    <span className="break-words">{view.status.text}</span>
                  </MessageItemStatus>
                ) : null}
                {details.logPath !== undefined ? (
                  // The tail is bounded by the runner; the whole log only ever exists on
                  // disk, so the item names the file rather than pretending this is all.
                  <span data-testid="tool-result-bash-log" className="min-w-0 break-all text-doom-faint">
                    full log · <span className="text-doom-dim">{details.logPath}</span>
                  </span>
                ) : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}
