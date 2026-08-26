import { Button, Input, SearchIcon, StatusBadge, type StatusTone } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunnerRunView } from '../src/types/webRunners.ts';
import type { RunnerLogResponse } from '../src/types/webRunnerLog.ts';
import { formatRunnerUptime, isFollowingLive, logViewLines } from './format.ts';
import { fetchRunnerLog, followRunnerLog } from './logApi.ts';
import { requestRunnerStop, runners } from './runnersStore.ts';

const TICK_MS = 10_000;
/** The tab id doubles as the URL segment, so it stays plain and unique across plugins. */
const TAB_ID_PREFIX = 'runner-log-';
/** Lines held in the view; a follow that ran all day must not grow without bound. */
const MAX_VIEW_LINES = 2000;
/** Context lines each side of a match, the same either-side window grep would use. */
const CONTEXT_LINES = 2;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** The temporary tab for one runner's log; the host keeps this panel while the tab is open. */
export function runnerLogTab(run: RunnerRunView): TransientTab {
  const runId = run.id;
  return {
    id: `${TAB_ID_PREFIX}${runId}`,
    label: `log · ${run.name}`,
    panel: (props: WebPluginSlotProps) => <RunnerLogPanel {...props} runId={runId} />,
  };
}

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function badgeOf(run: RunnerRunView | undefined): { tone: StatusTone; label: string } {
  if (run === undefined) return { tone: 'neutral', label: 'gone' };
  if (run.state === 'running') return { tone: 'running', label: 'running' };
  if (run.exit === undefined || run.exit.reason === 'stopped') return { tone: 'neutral', label: 'stopped' };
  const clean = run.exit.reason === 'completed' && (run.exit.code === 0 || run.exit.code === null);
  return clean ? { tone: 'ok', label: 'done' } : { tone: 'error', label: run.exit.reason.replace('_', ' ') };
}

/** One fact of the runner, on its own line so a long command is never elided. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 gap-2.5">
      <span className="w-14 shrink-0 text-[10px] text-doom-faint">{label}</span>
      <span className="min-w-0 flex-1 break-all text-[10px] text-doom-dim">{value}</span>
    </span>
  );
}

/**
 * One runner's log: the bounded tail, following while the runner writes, and
 * a grep over the whole file when the reader types a query.
 *
 * Search is not find-next. The reader matches a literal substring and answers
 * with the matching lines and their context, so a query replaces the view
 * rather than moving a cursor through it, and following pauses while one is
 * set because a filtered view is a snapshot of a file that is still growing.
 */
export function RunnerLogPanel({ sessionId, runId, sendSessionFrame }: WebPluginSlotProps & { runId: string }) {
  const { runs, stopRequested } = useStore(runners.store, (state) => runners.select(state, sessionId));
  const run = runs.find((candidate) => candidate.id === runId);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [context, setContext] = useState(CONTEXT_LINES);
  const [following, setFollowing] = useState(true);
  const [slice, setSlice] = useState<RunnerLogResponse | undefined>(undefined);
  const [appended, setAppended] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement | null>(null);

  const filtering = query !== '';
  const live = isFollowingLive(following, filtering, slice?.running === true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(
    (signal: AbortSignal) => {
      if (sessionId === null) return;
      const params = filtering ? { grep: query, ignoreCase, contextLines: context } : {};
      void fetchRunnerLog(sessionId, runId, params, signal).then((result) => {
        if (signal.aborted) return;
        if ('error' in result) {
          if (result.error !== '') setError(result.error);
          return;
        }
        setError(undefined);
        setAppended([]);
        setSlice(result.slice);
      });
    },
    [sessionId, runId, filtering, query, ignoreCase, context],
  );

  // Re-read whenever the question changes. A query is typed a character at a
  // time, so the in-flight request for the previous one is abandoned.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!live || sessionId === null || slice === undefined || !slice.running) return;
    const follow = followRunnerLog(sessionId, runId, slice.fileSize, {
      onEvent: (event) => {
        if (event.lines.length > 0) {
          setAppended((current) => [...current, ...event.lines].slice(-MAX_VIEW_LINES));
        }
        if (event.ended === true) setFollowing(false);
      },
      onError: () => setFollowing(false),
    });
    return () => follow.close();
  }, [live, sessionId, runId, slice]);

  const lines = logViewLines(slice?.text ?? '', appended, MAX_VIEW_LINES);

  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ block: 'end' });
  }, [live, lines.length]);

  const badge = badgeOf(run);
  const stopping = run !== undefined && stopRequested.includes(run.id);
  const elapsed =
    run === undefined ? '' : formatRunnerUptime(run.startedAt, run.exit ? Date.parse(run.exit.finishedAt) : now);

  return (
    <div data-testid="runner-log-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-[26px]">
        <span data-testid="runner-log-name" className="shrink-0 truncate text-[12px] font-bold text-doom-hi">
          {run?.name ?? runId}
        </span>
        <StatusBadge tone={badge.tone} data-testid="runner-log-state">
          {badge.label}
        </StatusBadge>
        {run ? (
          <>
            <span className="shrink-0 text-[10px] text-doom-faint">{elapsed}</span>
            <span className="shrink-0 text-[10px] text-doom-faint">
              {`pid ${String(run.pid)} · ${run.backend}${run.interactive ? ' · tty' : ''}`}
            </span>
          </>
        ) : (
          <span data-testid="runner-log-gone" className="text-[10px] text-doom-faint">
            no longer listed; its log stays readable
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {run !== undefined && run.state === 'running' && sessionId !== null ? (
          <Button
            variant={stopping ? 'outline' : 'danger-outline'}
            size="xs"
            data-testid="runner-log-stop"
            disabled={stopping}
            title={stopping ? 'stop requested; the runner reports its own exit' : 'ask the runtime to stop this runner'}
            onClick={() => requestRunnerStop(sendSessionFrame, sessionId, run.id)}
            className="px-2 text-[9px] font-bold"
          >
            {stopping ? 'stopping…' : 'stop'}
          </Button>
        ) : null}
      </div>

      {run ? (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-doom-border-soft px-[26px] py-2.5">
          <MetaRow label="command" value={run.command} />
          <MetaRow label="cwd" value={run.cwd} />
        </div>
      ) : null}

      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-[26px]">
        <span className="relative flex w-[300px] shrink-0 items-center">
          <SearchIcon className="pointer-events-none absolute left-2.5 h-3 w-3 text-doom-faint" />
          <Input
            size="sm"
            data-testid="runner-log-search"
            value={query}
            placeholder="search this log"
            onChange={(event) => setQuery(event.target.value)}
            className="pl-7 text-[10px]"
          />
        </span>
        <Button
          variant={ignoreCase ? 'subtle' : 'outline'}
          size="xs"
          data-testid="runner-log-ignore-case"
          aria-pressed={ignoreCase}
          title="match regardless of case"
          onClick={() => setIgnoreCase((current) => !current)}
          className="px-2 text-[9px] font-bold"
        >
          aA
        </Button>
        <Button
          variant={context > 0 && filtering ? 'subtle' : 'outline'}
          size="xs"
          data-testid="runner-log-context"
          disabled={!filtering}
          title="lines of context kept either side of a match"
          onClick={() => setContext((current) => (current === 0 ? CONTEXT_LINES : 0))}
          className="px-2 text-[9px] font-bold"
        >
          {`± ${String(context)} lines`}
        </Button>
        <span className="min-w-0 flex-1" />
        <span data-testid="runner-log-stats" className="shrink-0 text-[10px] text-doom-faint">
          {slice === undefined
            ? 'reading…'
            : filtering
              ? `${String(slice.lineCount)} matching of ${slice.totalLines.toLocaleString('en-US')} lines`
              : `${live ? 'tailing' : 'showing'} last ${String(lines.length)} of ${slice.totalLines.toLocaleString('en-US')} lines`}
        </span>
        <Button
          variant={live ? 'subtle' : 'outline'}
          size="xs"
          data-testid="runner-log-follow"
          aria-pressed={live}
          disabled={filtering || slice?.running !== true}
          title={filtering ? 'a filtered view is a snapshot; clear the query to follow' : 'follow the log as it grows'}
          onClick={() => setFollowing((current) => !current)}
          className="px-2 text-[9px] font-bold"
        >
          {filtering ? 'follow · paused' : 'follow'}
        </Button>
      </div>

      <div data-testid="runner-log-body" className="min-h-0 flex-1 overflow-auto bg-doom-panel-deep px-[26px] py-3">
        {error !== undefined ? (
          <p data-testid="runner-log-error" className="text-[10px] text-doom-red">
            {error}
          </p>
        ) : slice !== undefined && slice.exists === false ? (
          <p className="text-[10px] text-doom-faint">this runner has not written a log yet</p>
        ) : lines.length === 0 ? (
          <p className="text-[10px] text-doom-faint">{filtering ? 'nothing matched' : 'the log is empty'}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.6] text-doom-dim">
            {lines.join('\n')}
          </pre>
        )}
        <div ref={bottom} />
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2.5 border-t border-doom-border-soft px-[26px]">
        <span data-testid="runner-log-path" className="min-w-0 flex-1 truncate text-[9px] text-doom-faint">
          {run?.logPath ?? slice?.path ?? ''}
        </span>
        {slice !== undefined ? (
          <span className="shrink-0 text-[9px] text-doom-faint">{formatSize(slice.fileSize)}</span>
        ) : null}
      </div>
    </div>
  );
}
