import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { abbreviateCwd, runningCount, type AttachPhase } from '../../lib/sessionSummary.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore, useActiveSessionMeta } from '../../stores/sessionsStore.ts';
import { subagentsStore } from '../../stores/subagentsStore.ts';
import { workflowsStore } from '../../stores/workflowsStore.ts';

function ActIcon() {
  return (
    <svg viewBox="0 0 10 10" className="h-[10px] w-[10px] shrink-0" aria-hidden>
      <path
        d="M1 5.5 H3 L4.2 2.5 L5.8 7.5 L7 5.5 H9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The pill folds attach state and run state into one word, the way the mockup
 * does: a healthy idle session says "attached", a healthy busy one says
 * "running", and anything else names its trouble.
 */
function pill(attach: AttachPhase, busy: boolean): { text: string; className: string; dot: string } {
  if (attach === 'attached' && busy)
    return { text: 'running', className: 'bg-[#312A1C] text-doom-yellow', dot: 'bg-doom-yellow' };
  if (attach === 'attached')
    return { text: 'attached', className: 'bg-[#262E1E] text-doom-green', dot: 'bg-doom-green' };
  if (attach === 'connecting' || attach === 'detached') {
    return { text: attach, className: 'bg-[#312A1C] text-doom-yellow', dot: 'bg-doom-yellow' };
  }
  return { text: attach, className: 'bg-[#332428] text-doom-red', dot: 'bg-doom-red' };
}

export function TopBar({ view = 'conversation' }: { view?: 'conversation' | 'subagents' | 'workflows' }) {
  const meta = useActiveSessionMeta();
  const session = useActiveSession((state) => state);
  const running = useStore(sessionsStore, (state) =>
    runningCount(state.order.map((id) => state.byId[id].summary.phase)),
  );
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const runCount = useStore(subagentsStore, (state) =>
    activeId === null ? 0 : (state.bySession[activeId]?.length ?? 0),
  );
  const workflowCount = useStore(workflowsStore, (state) =>
    activeId === null ? 0 : (state.bySession[activeId]?.filter((run) => run.stage === 'running').length ?? 0),
  );
  const attach: AttachPhase = meta?.attach ?? 'offline';
  const busy = session.streaming || (meta !== null && meta.summary.phase !== 'idle');
  const state = pill(attach, busy);

  return (
    <header
      data-testid="top-bar"
      className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-doom-border px-5"
    >
      <div data-testid="session-switcher" className="flex min-w-0 items-center gap-2.5">
        <span data-testid="session-title" className="shrink-0 text-[13px] font-bold text-doom-hi">
          {meta?.summary.name || session.agent?.sessionName || 'untitled'}
        </span>
        {meta ? (
          <>
            <span className="text-[12px] text-doom-faint">·</span>
            <span data-testid="top-cwd" className="truncate text-[11px] text-doom-dim">
              {abbreviateCwd(meta.summary.cwd)}
            </span>
          </>
        ) : null}
        {activeId !== null ? (
          <div className="ml-1.5 flex shrink-0 items-center gap-1.5">
            <Link
              to="/session/$sessionId"
              params={{ sessionId: activeId }}
              data-testid="tab-conversation"
              data-active={view === 'conversation'}
              className={`rounded px-2 py-1 text-[10px] ${
                view === 'conversation' ? 'bg-[#21313F] font-bold text-doom-blue' : 'text-doom-dim hover:text-doom-hi'
              }`}
            >
              conversation
            </Link>
            <Link
              to="/session/$sessionId/subagents"
              params={{ sessionId: activeId }}
              data-testid="tab-subagents"
              data-active={view === 'subagents'}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] ${
                view === 'subagents' ? 'bg-[#21313F] font-bold text-doom-blue' : 'text-doom-dim hover:text-doom-hi'
              }`}
            >
              subagents
              {runCount > 0 ? (
                <span
                  data-testid="tab-subagents-count"
                  className={`flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[8px] font-bold ${
                    view === 'subagents' ? 'bg-doom-blue text-doom-rail' : 'bg-doom-panel text-doom-dim'
                  }`}
                >
                  {runCount}
                </span>
              ) : null}
            </Link>
            <Link
              to="/session/$sessionId/workflows"
              params={{ sessionId: activeId }}
              data-testid="tab-workflows"
              data-active={view === 'workflows'}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] ${
                view === 'workflows' ? 'bg-[#21313F] font-bold text-doom-blue' : 'text-doom-dim hover:text-doom-hi'
              }`}
            >
              workflows
              {workflowCount > 0 ? (
                <span
                  data-testid="tab-workflows-count"
                  className={`flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[8px] font-bold ${
                    view === 'workflows' ? 'bg-doom-blue text-doom-rail' : 'bg-doom-panel text-doom-dim'
                  }`}
                >
                  {workflowCount}
                </span>
              ) : null}
            </Link>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {meta && meta.replayed > 0 ? (
          <span data-testid="replayed-count" className="text-[10px] text-doom-faint">
            replayed {meta.replayed}
          </span>
        ) : null}
        {meta && meta.dropped > 0 ? (
          <span data-testid="dropped-count" className="text-[10px] text-doom-yellow">
            {meta.dropped} dropped
          </span>
        ) : null}
        <span
          data-testid="connection-status"
          className={`flex h-[21px] items-center gap-1.5 rounded px-2 text-[10px] ${state.className}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
          {state.text}
        </span>
        <span
          data-testid="sessions-running"
          className="flex h-[21px] items-center gap-1.5 rounded bg-[#312A1C] px-2 text-[10px] text-doom-yellow"
        >
          <ActIcon />
          {running} running
        </span>
      </div>
    </header>
  );
}
