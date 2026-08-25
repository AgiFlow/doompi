import {
  ActivityIcon,
  Button,
  CloseIcon,
  Dot,
  type DotTone,
  NavTab,
  NavTabBadge,
  StatusBadge,
  type StatusTone,
} from '@agimon-ai/doompi-web-components';
import type { TabContribution, TransientTab } from '@agimon-ai/doompi-web-contracts';
import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { abbreviateCwd, runningCount, type AttachPhase } from '../../lib/sessionSummary.ts';
import { webTabs } from '../../lib/pluginRegistry.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore, useActiveSessionMeta } from '../../stores/sessionsStore.ts';
import { closeTransientTab, useTransientTabs } from '../../stores/transientTabsStore.ts';

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

/** One registry tab: the badge hook is stable per tab, so the call is unconditional. */
function PluginTab({ tab, sessionId, active }: { tab: TabContribution; sessionId: string; active: boolean }) {
  const useBadge = tab.useBadge ?? noBadge;
  const count = useBadge(sessionId);
  return (
    <NavTab asChild active={active}>
      <Link
        to="/session/$sessionId/$tabId"
        params={{ sessionId, tabId: tab.id }}
        data-testid={`tab-${tab.id}`}
        className="shrink-0"
      >
        {tab.label}
        {count > 0 ? (
          <NavTabBadge active={active} data-testid={`tab-${tab.id}-count`}>
            {count}
          </NavTabBadge>
        ) : null}
      </Link>
    </NavTab>
  );
}

function noBadge(): number {
  return 0;
}

/**
 * A tab a plugin opened at runtime: its link with the close beside it, since
 * a button cannot live inside a link. Closing the shown tab needs no
 * navigation of its own; the page falls back to the conversation once the
 * id is gone.
 */
function TransientTabChip({ tab, sessionId, active }: { tab: TransientTab; sessionId: string; active: boolean }) {
  return (
    <span data-testid={`tab-${tab.id}-chip`} className="flex shrink-0 items-center gap-0.5">
      <NavTab asChild active={active}>
        <Link
          to="/session/$sessionId/$tabId"
          params={{ sessionId, tabId: tab.id }}
          data-testid={`tab-${tab.id}`}
          title={tab.label}
          className="block min-w-0 max-w-[160px] truncate"
        >
          {tab.label}
        </Link>
      </NavTab>
      <Button
        variant="ghost"
        size="icon"
        data-testid={`tab-${tab.id}-close`}
        title="close this tab"
        onClick={() => closeTransientTab(sessionId, tab.id)}
        className="h-5 w-5 shrink-0"
      >
        <CloseIcon className="h-2.5 w-2.5" />
      </Button>
    </span>
  );
}

export function TopBar({ view = 'conversation' }: { view?: string }) {
  const meta = useActiveSessionMeta();
  const session = useActiveSession((state) => state);
  const running = useStore(sessionsStore, (state) =>
    runningCount(state.order.map((id) => state.byId[id].summary.phase)),
  );
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const transientTabs = useTransientTabs(activeId);
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
          // Tabs never shrink; past the width the badges leave them, the strip
          // scrolls sideways (scrollbar hidden) instead of running under them.
          <div className="ml-1.5 flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <NavTab asChild active={view === 'conversation'}>
              <Link
                to="/session/$sessionId"
                params={{ sessionId: activeId }}
                data-testid="tab-conversation"
                className="shrink-0"
              >
                conversation
              </Link>
            </NavTab>
            {webTabs().map((tab) => (
              <PluginTab key={tab.id} tab={tab} sessionId={activeId} active={view === tab.id} />
            ))}
            {transientTabs.map((tab) => (
              <TransientTabChip key={tab.id} tab={tab} sessionId={activeId} active={view === tab.id} />
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
