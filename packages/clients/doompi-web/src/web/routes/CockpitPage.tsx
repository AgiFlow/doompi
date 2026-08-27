import { Button } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PluginSurface } from '../components/PluginSurface.tsx';
import { usePluginSlotProps } from '../stores/usePluginSlotProps.ts';
import { ActivityDock } from '../features/activity/ActivityDock.tsx';
import { RefusedCard } from '../features/connection/RefusedCard.tsx';
import { DialogOverlay } from '../features/dialogs/DialogOverlay.tsx';
import { CommandPalette } from '../features/leader/CommandPalette.tsx';
import { SelectionBar } from '../features/selection/SelectionBar.tsx';
import { Composer } from '../features/session/Composer.tsx';
import { SessionRail } from '../features/sessions/SessionRail.tsx';
import { WelcomePanel } from '../features/sessions/WelcomePanel.tsx';
import { Timeline } from '../features/session/Timeline.tsx';
import { TopBar } from '../features/status/TopBar.tsx';
import { HOST_SLOTS, webTabs } from '../lib/pluginRegistry.ts';
import { sessionsStore, setActiveSession, useNoSessions } from '../stores/sessionsStore.ts';
import { findTransientTab, transientTabsStore } from '../stores/transientTabsStore.ts';
import { setDockOpen, uiStore } from '../stores/uiStore.ts';

export function CockpitPage() {
  const dockOpen = useStore(uiStore, (state) => state.dockOpen);
  const [railOpen, setRailOpen] = useState(false);
  const [mobileActivityOpen, setMobileActivityOpen] = useState(false);
  const { sessionId, tabId } = useParams({ strict: false });
  const navigate = useNavigate();
  const slotProps = usePluginSlotProps(sessionId ?? null);
  const order = useStore(sessionsStore, (state) => state.order);
  const hydrated = useStore(sessionsStore, (state) => state.hydrated);
  const noSessions = useNoSessions();
  // A declared tab first, then one a plugin opened at runtime for this session.
  const transientTab = useStore(transientTabsStore, (state) => findTransientTab(state, sessionId, tabId));
  const tab = (tabId === undefined ? undefined : webTabs().find((entry) => entry.id === tabId)) ?? transientTab;

  // The route is the source of focus; the store follows it.
  useEffect(() => {
    setActiveSession(sessionId ?? null);
  }, [sessionId]);

  // Landing on / focuses the first session; a focused session that
  // disappeared falls back the same way, and an unknown tab id falls back to
  // the conversation. Before hydration the URL is left alone so a deep link
  // survives the socket connecting.
  useEffect(() => {
    if (!hydrated) return;
    if (sessionId !== undefined && order.includes(sessionId)) {
      if (tabId !== undefined && tab === undefined) {
        void navigate({ to: '/session/$sessionId', params: { sessionId }, replace: true });
      }
      return;
    }
    const first = order[0];
    if (first !== undefined) {
      void navigate({ to: '/session/$sessionId', params: { sessionId: first }, replace: true });
    } else if (sessionId !== undefined) {
      void navigate({ to: '/', replace: true });
    }
  }, [hydrated, sessionId, tabId, tab, order, navigate]);

  const activityDockClass = mobileActivityOpen
    ? dockOpen
      ? 'fixed inset-y-0 right-0 z-40 flex lg:static lg:z-auto'
      : 'fixed inset-y-0 right-0 z-40 flex lg:hidden'
    : dockOpen
      ? 'hidden lg:flex'
      : 'hidden';

  const closeActivity = (): void => {
    if (window.matchMedia('(min-width: 1024px)').matches) setDockOpen(false);
    else setMobileActivityOpen(false);
  };
  return (
    <div data-testid="cockpit" className="relative flex h-full min-w-0 overflow-hidden">
      <aside
        data-testid="session-rail-panel"
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(300px,calc(100vw-48px))] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail transition-transform md:visible md:static md:z-auto md:w-[300px] md:translate-x-0 ${railOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
      >
        <SessionRail onDismiss={() => setRailOpen(false)} />
      </aside>
      {railOpen ? (
        <Button
          variant="ghost"
          data-testid="mobile-drawer-backdrop"
          aria-label="hide sessions"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/55 p-0 hover:bg-black/55 md:hidden"
          onClick={() => setRailOpen(false)}
        />
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          view={tab?.id ?? 'conversation'}
          onShowSessions={() => {
            setMobileActivityOpen(false);
            setRailOpen(true);
          }}
          onShowActivity={() => {
            setRailOpen(false);
            setMobileActivityOpen(true);
          }}
        />
        {/* The composer and the selection bar address the session's agent, so
            they belong to the conversation alone. A plugin panel is a view of
            something else, and a prompt box under it would send somewhere the
            reader is not looking. */}
        {tab ? (
          <tab.panel {...slotProps} />
        ) : noSessions ? (
          // Same reasoning as above, taken to its end: with no session there is
          // no agent to address, so the conversation and everything that talks
          // to it give way to the one thing there is to do.
          <WelcomePanel />
        ) : (
          <>
            <Timeline />
            <Composer />
            <SelectionBar />
          </>
        )}
      </main>
      {dockOpen || mobileActivityOpen ? (
        <div className={activityDockClass}>
          <ActivityDock onClose={closeActivity} />
        </div>
      ) : (
        <Button
          variant="ghost"
          data-testid="activity-show"
          title="show the activity dock"
          onClick={() => setDockOpen(true)}
          className="hidden h-auto shrink-0 rounded-none border-l border-doom-border bg-doom-rail px-2 py-3 text-[9px] tracking-widest text-doom-dim hover:bg-doom-rail lg:flex"
          style={{ writingMode: 'vertical-rl' }}
        >
          ACTIVITY
        </Button>
      )}
      {mobileActivityOpen ? (
        <Button
          variant="ghost"
          data-testid="mobile-activity-backdrop"
          aria-label="hide activity"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/55 p-0 hover:bg-black/55 lg:hidden"
          onClick={() => setMobileActivityOpen(false)}
        />
      ) : null}
      <DialogOverlay />
      <RefusedCard />
      <CommandPalette />
      <PluginSurface slot={HOST_SLOTS.overlay} sessionId={sessionId ?? null} />
    </div>
  );
}
