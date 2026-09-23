import { useNavigate, useParams } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';

import { TemplateHost } from '../components/TemplateHost';
import { ActivityDock } from '../features/activity/ActivityDock';
import { SelectionBar } from '../features/selection/SelectionBar';
import { Composer } from '../features/session/Composer';
import { Timeline } from '../features/session/Timeline';
import { SessionRail } from '../features/sessions/SessionRail';
import { WelcomePanel } from '../features/sessions/WelcomePanel';
import { TopBar } from '../features/status/TopBar';
import { pluginActivityGroups, webTabs } from '../lib/pluginRegistry';
import { sessionsStore, setActiveSession, useActiveSessionMeta, useNoSessions } from '../stores/sessionsStore';
import { useActiveSession } from '../stores/sessionStore';
import { findTransientTab, transientTabsStore } from '../stores/transientTabsStore';
import { setDockOpen, uiStore } from '../stores/uiStore';
import { usePluginSlotProps } from '../stores/usePluginSlotProps';
import { useWebPluginRegistry } from '../stores/useWebPluginRegistry';
import { workspacesStore } from '../stores/workspacesStore';

export function CockpitPage() {
  useWebPluginRegistry();
  const dockOpen = useStore(uiStore, (state) => state.dockOpen);
  const [railOpen, setRailOpen] = useState(false);
  const [mobileActivityOpen, setMobileActivityOpen] = useState(false);
  const { sessionId, tabId } = useParams({ strict: false });
  const navigate = useNavigate();
  const slotProps = usePluginSlotProps(sessionId ?? null);
  const order = useStore(sessionsStore, (state) => state.order);
  const hydrated = useStore(sessionsStore, (state) => state.hydrated);
  const sessionWorkspaceId = useStore(sessionsStore, (state) =>
    sessionId === undefined ? undefined : state.byId[sessionId]?.summary.workspaceId,
  );
  const selectedWorkspaceId = useStore(workspacesStore, (state) => state.selectedId);
  const workspaceId = sessionId === undefined ? (selectedWorkspaceId ?? undefined) : sessionWorkspaceId;
  // The landing redirect and deep-link hydration must finish before choosing a template scope.
  const templateScopeReady = hydrated && (sessionId === undefined ? order.length === 0 : order.includes(sessionId));
  const transferLabel = useStore(sessionsStore, (state) => {
    if (state.transferringToId === null) return null;
    return state.byId[state.transferringToId]?.summary.name ?? 'destination session';
  });
  const noSessions = useNoSessions();
  const activeMeta = useActiveSessionMeta();
  const dormantMeta = activeMeta?.summary.dormant === true ? activeMeta : null;
  const dialogId = useActiveSession((state) => state.dialog?.id ?? null);
  // A declared tab first, then one a plugin opened at runtime for this session.
  // Session plugin compositions replace the builtin plugin module after verification.
  // Refresh activity-owned tabs from the active registry so a tab opened during that
  // handoff does not keep rendering the retired module's disconnected stores.
  const storedTransientTab = useStore(transientTabsStore, (state) => findTransientTab(state, sessionId, tabId));
  const transientTab =
    storedTransientTab === undefined
      ? undefined
      : (pluginActivityGroups()
          .map((group) => group.transientTab?.())
          .find((candidate) => candidate?.id === storedTransientTab.id) ?? storedTransientTab);
  const tab = (tabId === undefined ? undefined : webTabs().find((entry) => entry.id === tabId)) ?? transientTab;

  // Both side panels are temporary drawers on mobile. Route changes can also
  // come from plugin navigation, so they dismiss the drawers even when no
  // drawer item produced the navigation event directly. A modal must not
  // compete with the mobile activity drawer for the viewport either, so an
  // opening dialog closes it. Both are adjustments made while rendering the
  // change rather than in an effect, so no extra pass paints the open drawer.
  const routeKey = `${sessionId ?? ''}\u0000${tabId ?? ''}`;
  const [lastRouteKey, setLastRouteKey] = useState(routeKey);
  if (lastRouteKey !== routeKey) {
    setLastRouteKey(routeKey);
    setRailOpen(false);
    setMobileActivityOpen(false);
  }

  const [lastDialogId, setLastDialogId] = useState(dialogId);
  if (lastDialogId !== dialogId) {
    setLastDialogId(dialogId);
    if (dialogId !== null) {
      setMobileActivityOpen(false);
      setRailOpen(false);
    }
  }

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

  const closeActivity = (): void => {
    if (mobileActivityOpen) setMobileActivityOpen(false);
    else setDockOpen(false);
  };
  return (
    <div data-testid="cockpit" className="h-full min-w-0 overflow-hidden">
      <TemplateHost
        scopeReady={templateScopeReady}
        mount={
          workspaceId === undefined
            ? { scope: 'global' }
            : sessionId === undefined
              ? { scope: 'workspace', workspaceId }
              : { scope: 'session', workspaceId, sessionId }
        }
        view={tab ? 'panel' : noSessions ? 'welcome' : 'conversation'}
        navigationOpen={railOpen}
        desktopActivityOpen={dockOpen}
        mobileActivityOpen={mobileActivityOpen}
        onNavigationOpenChange={setRailOpen}
        onDesktopActivityOpenChange={setDockOpen}
        onMobileActivityOpenChange={setMobileActivityOpen}
        slots={{
          navigation: <SessionRail onDismiss={() => setRailOpen(false)} />,
          header: (options) => (
            <TopBar
              {...options}
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
          ),
          notices:
            transferLabel === null ? null : (
              <output
                data-testid="voice-transfer-transition"
                className="border-b border-doom-cyan/30 bg-doom-cyan/10 px-4 py-2 text-center text-sm font-bold tracking-wide text-doom-cyan"
              >
                Transferring voice to {transferLabel}...
              </output>
            ),
          content: tab ? <tab.panel {...slotProps} /> : noSessions ? <WelcomePanel /> : <Timeline />,
          // A plugin panel may replace the conversation; retained composers still own wake gating.
          composer: tab ? tab.retainComposer === true ? <Composer /> : null : noSessions ? null : <Composer />,
          controls: !tab && !noSessions && dormantMeta === null ? <SelectionBar /> : null,
          activity: <ActivityDock onClose={closeActivity} onOpenContent={() => setMobileActivityOpen(false)} />,
        }}
      />
    </div>
  );
}
