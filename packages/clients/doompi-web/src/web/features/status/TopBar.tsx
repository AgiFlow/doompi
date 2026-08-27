import {
  ActivityIcon,
  Button,
  CloseIcon,
  Dot,
  type DotTone,
  Input,
  NavTab,
  NavTabBadge,
  StatusBadge,
  type StatusTone,
} from '@agimon-ai/doompi-web-components';
import type { TabContribution, TransientTab } from '@agimon-ai/doompi-web-contracts';
import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import { abbreviateCwd, runningCount, type AttachPhase } from '../../lib/sessionSummary.ts';
import { webTabs } from '../../lib/pluginRegistry.ts';
import { renameSession, useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore, useActiveSessionMeta, useNoSessions } from '../../stores/sessionsStore.ts';
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

export function TopBar({
  view = 'conversation',
  onShowSessions,
  onShowActivity,
}: {
  view?: string;
  onShowSessions?: () => void;
  onShowActivity?: () => void;
}) {
  const meta = useActiveSessionMeta();
  const session = useActiveSession((state) => state);
  const running = useStore(sessionsStore, (state) =>
    runningCount(state.order.map((id) => state.byId[id].summary.phase)),
  );
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const noSessions = useNoSessions();
  const transientTabs = useTransientTabs(activeId);
  const attach: AttachPhase = meta?.attach ?? 'offline';
  const busy = session.streaming || (meta !== null && meta.summary.phase !== 'idle');
  const state = pill(attach, busy);
  const title = meta?.summary.name || session.agent?.sessionName || 'untitled';
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  // The name lives in the agent, so the rail's rename and this one are the
  // same act through the same door; the new name arrives back on the socket.
  const commitRename = (): void => {
    const next = draft.trim();
    if (next && next !== title) renameSession(next, activeId);
    setRenaming(false);
  };

  return (
    <header
      data-testid="top-bar"
      className="flex h-12 shrink-0 items-center justify-between gap-1.5 border-b border-doom-border px-2 sm:gap-3 sm:px-5"
    >
      <div data-testid="session-switcher" className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2.5">
        {onShowSessions ? (
          <Button
            variant="ghost"
            size="icon"
            data-testid="mobile-sessions-open"
            title="show sessions"
            aria-label="show sessions"
            onClick={onShowSessions}
            className="shrink-0 text-[16px] text-doom-dim md:hidden"
          >
            <span aria-hidden>☰</span>
          </Button>
        ) : null}
        {/* With no session there is no name to show and no state to report, so
            the bar carries neither rather than reporting 'untitled' and
            'offline' for something that was never started. */}
        {noSessions ? null : renaming && activeId !== null ? (
          <Input
            data-testid="session-title-input"
            value={draft}
            autoFocus
            aria-label="session name"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') setRenaming(false);
            }}
            onBlur={commitRename}
            className="h-6 w-44 shrink-0 border-doom-blue/60 px-1.5 text-[13px] font-bold"
          />
        ) : (
          <Button
            variant="ghost"
            data-testid="session-title"
            title={activeId === null ? undefined : 'rename this session'}
            disabled={activeId === null}
            onClick={() => {
              setDraft(title);
              setRenaming(true);
            }}
            className="h-6 max-w-24 shrink-0 truncate px-1 text-[13px] font-bold text-doom-hi max-sm:hidden sm:max-w-44"
          >
            {title}
          </Button>
        )}
        {meta ? (
          <>
            <span className="text-[12px] text-doom-faint max-sm:hidden">·</span>
            <span data-testid="top-cwd" className="truncate text-[11px] text-doom-dim max-sm:hidden">
              {abbreviateCwd(meta.summary.cwd)}
            </span>
          </>
        ) : null}
        {activeId !== null ? (
          // Tabs never shrink; past the width the badges leave them, the strip
          // scrolls sideways (scrollbar hidden) instead of running under them.
          <div className="ml-0 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:ml-1.5 sm:gap-1.5 [&::-webkit-scrollbar]:hidden">
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

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        {noSessions ? null : (
          <>
            {meta && meta.dropped > 0 ? (
              <span
                data-testid="dropped-count"
                title="frames the hub's ring lost before this page subscribed"
                className="text-[10px] text-doom-yellow"
              >
                {meta.dropped} dropped
              </span>
            ) : null}
            <StatusBadge
              size="md"
              tone={state.tone}
              data-testid="connection-status"
              className="font-normal max-sm:hidden"
            >
              <Dot tone={state.dot} pulse={state.pulse} />
              {state.text}
            </StatusBadge>
            <StatusBadge size="md" tone="running" data-testid="sessions-running" className="font-normal max-lg:hidden">
              <ActivityIcon className="h-[10px] w-[10px]" />
              {running} running
            </StatusBadge>
          </>
        )}
        {onShowActivity ? (
          <Button
            variant="ghost"
            size="icon"
            data-testid="mobile-activity-open"
            title="show activity"
            aria-label="show activity"
            onClick={onShowActivity}
            className="shrink-0 text-doom-dim lg:hidden"
          >
            <ActivityIcon className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
