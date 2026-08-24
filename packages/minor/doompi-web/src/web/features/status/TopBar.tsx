import { ActivityIcon, Dot, type DotTone, StatusBadge, type StatusTone } from '@agimon-ai/doompi-web-components';
import type { TabContribution } from '@agimon-ai/doompi-web-contracts';
import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { abbreviateCwd, runningCount, type AttachPhase } from '../../lib/sessionSummary.ts';
import { webTabs } from '../../lib/pluginRegistry.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore, useActiveSessionMeta } from '../../stores/sessionsStore.ts';

/**
 * The pill folds attach state and run state into one word, the way the mockup
 * does: a healthy idle session says "attached", a healthy busy one says
 * "running", and anything else names its trouble.
 */
function pill(attach: AttachPhase, busy: boolean): { text: string; tone: StatusTone; dot: DotTone; pulse: boolean } {
  if (attach === 'attached' && busy) return { text: 'running', tone: 'running', dot: 'yellow', pulse: true };
  if (attach === 'attached') return { text: 'attached', tone: 'ok', dot: 'green', pulse: false };
  if (attach === 'connecting' || attach === 'detached') {
    return { text: attach, tone: 'running', dot: 'yellow', pulse: attach === 'connecting' };
  }
  return { text: attach, tone: 'error', dot: 'red', pulse: false };
}

const TAB_CLASS = 'flex items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors';
const TAB_ACTIVE = 'bg-doom-tint-blue font-bold text-doom-blue';
const TAB_IDLE = 'text-doom-dim hover:bg-doom-panel hover:text-doom-hi';

/** One registry tab: the badge hook is stable per tab, so the call is unconditional. */
function PluginTab({ tab, sessionId, active }: { tab: TabContribution; sessionId: string; active: boolean }) {
  const useBadge = tab.useBadge ?? noBadge;
  const count = useBadge(sessionId);
  return (
    <Link
      to="/session/$sessionId/$tabId"
      params={{ sessionId, tabId: tab.id }}
      data-testid={`tab-${tab.id}`}
      data-active={active}
      className={`${TAB_CLASS} ${active ? TAB_ACTIVE : TAB_IDLE}`}
    >
      {tab.label}
      {count > 0 ? (
        <span
          data-testid={`tab-${tab.id}-count`}
          className={`flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[8px] font-bold ${
            active ? 'bg-doom-blue text-doom-rail' : 'bg-doom-panel text-doom-dim'
          }`}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function noBadge(): number {
  return 0;
}

export function TopBar({ view = 'conversation' }: { view?: string }) {
  const meta = useActiveSessionMeta();
  const session = useActiveSession((state) => state);
  const running = useStore(sessionsStore, (state) =>
    runningCount(state.order.map((id) => state.byId[id].summary.phase)),
  );
  const activeId = useStore(sessionsStore, (state) => state.activeId);
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
              className={`${TAB_CLASS} ${view === 'conversation' ? TAB_ACTIVE : TAB_IDLE}`}
            >
              conversation
            </Link>
            {webTabs().map((tab) => (
              <PluginTab key={tab.id} tab={tab} sessionId={activeId} active={view === tab.id} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {meta && meta.replayed > 0 ? (
          <span
            data-testid="replayed-count"
            title="frames replayed into this page"
            className="text-[10px] text-doom-faint"
          >
            replayed {meta.replayed}
          </span>
        ) : null}
        {meta && meta.dropped > 0 ? (
          <span
            data-testid="dropped-count"
            title="frames the hub's ring lost before this page subscribed"
            className="text-[10px] text-doom-yellow"
          >
            {meta.dropped} dropped
          </span>
        ) : null}
        <StatusBadge size="md" tone={state.tone} data-testid="connection-status" className="font-normal">
          <Dot tone={state.dot} pulse={state.pulse} />
          {state.text}
        </StatusBadge>
        <StatusBadge size="md" tone="running" data-testid="sessions-running" className="font-normal">
          <ActivityIcon className="h-[10px] w-[10px]" />
          {running} running
        </StatusBadge>
      </div>
    </header>
  );
}
