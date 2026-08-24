import { useStore } from '@tanstack/react-store';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PluginSurface } from '../components/PluginSurface.tsx';
import { ActivityDock } from '../features/activity/ActivityDock.tsx';
import { RefusedCard } from '../features/connection/RefusedCard.tsx';
import { DialogOverlay } from '../features/dialogs/DialogOverlay.tsx';
import { CommandPalette } from '../features/leader/CommandPalette.tsx';
import { SelectionBar } from '../features/selection/SelectionBar.tsx';
import { Composer } from '../features/session/Composer.tsx';
import { SessionRail } from '../features/sessions/SessionRail.tsx';
import { Timeline } from '../features/session/Timeline.tsx';
import { TopBar } from '../features/status/TopBar.tsx';
import { webTabs } from '../lib/pluginRegistry.ts';
import { sessionsStore, setActiveSession } from '../stores/sessionsStore.ts';

export function CockpitPage() {
  const [dockOpen, setDockOpen] = useState(true);
  const { sessionId, tabId } = useParams({ strict: false });
  const navigate = useNavigate();
  const order = useStore(sessionsStore, (state) => state.order);
  const hydrated = useStore(sessionsStore, (state) => state.hydrated);
  const tab = tabId === undefined ? undefined : webTabs().find((entry) => entry.id === tabId);

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

  return (
    <div data-testid="cockpit" className="relative flex h-full overflow-hidden">
      <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-doom-border bg-doom-rail">
        <SessionRail />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar view={tab?.id ?? 'conversation'} />
        {tab ? <tab.panel sessionId={sessionId ?? null} /> : <Timeline />}
        <Composer />
        <SelectionBar />
      </main>
      {dockOpen ? (
        <ActivityDock onClose={() => setDockOpen(false)} />
      ) : (
        <button
          type="button"
          data-testid="activity-show"
          onClick={() => setDockOpen(true)}
          className="shrink-0 border-l border-doom-border bg-doom-rail px-2 text-[9px] tracking-widest text-doom-dim hover:text-doom-hi"
          style={{ writingMode: 'vertical-rl' }}
        >
          ACTIVITY
        </button>
      )}
      <DialogOverlay />
      <RefusedCard />
      <CommandPalette />
      <PluginSurface slot="overlay" sessionId={sessionId ?? null} />
    </div>
  );
}
