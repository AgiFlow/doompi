import type { WebTemplateRail } from '@agimon-ai/doompi-core/web';
import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PluginSurface } from '../../components/PluginSurface';
import {
  admitWorkspace,
  listDirectory,
  listWorkspaces,
  removeWorkspace,
  restartSession,
  searchDirectories,
  stopSession,
} from '../../lib/hubApi';
import { HOST_SLOTS } from '../../lib/pluginRegistry';
import { loadSessionAvatar } from '../../lib/sessionAvatar';
import { removeSessionMcpSetup } from '../../lib/sessionMcpApi';
import { buildRailWorkspaces, type RailRestartState } from '../../lib/sessionRailModel';
import { DEFAULT_REPOSITORY_SETTINGS_SECTION, DEFAULT_SETTINGS_SECTION } from '../../lib/settingsSections';
import { closeNewSession, newSessionStore, openNewSession } from '../../stores/newSessionStore';
import { paletteStore } from '../../stores/paletteStore';
import { openResumeDialog } from '../../stores/railDialogStore';
import { openRemoteDialog, remoteAccessStore, turnRemoteAccessOff } from '../../stores/remoteAccessStore';
import { applySessionRemoved, resolveParentId, sessionsStore, type SessionMeta } from '../../stores/sessionsStore';
import { renameSession, sessionStoreFor } from '../../stores/sessionStore';
import {
  applyWorkspaceRemoved,
  applyWorkspacesSnapshot,
  applyWorkspaceUpsert,
  selectWorkspace,
  workspacesStore,
} from '../../stores/workspacesStore';

const STATUS_REFRESH_MS = 30_000;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** A key pressed inside an overlay belongs to that overlay, never to the rail. */
function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"], [role="menu"], [role="alertdialog"]') !== null;
}

/**
 * Loads each distinct profile avatar once, keyed by profile and icon version so
 * sessions sharing a persona share one image, and revokes images no card shows.
 */
function useSessionAvatars(order: readonly string[], byId: Readonly<Record<string, SessionMeta>>) {
  const wanted = new Map<string, string>();
  for (const id of order) {
    const profile = byId[id]?.summary.profile;
    if (profile?.iconVersion !== undefined) wanted.set(id, `${profile.name}:${profile.iconVersion}`);
  }
  const wantedKey = [...wanted].map(([id, key]) => `${id}=${key}`).join('\n');
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({});
  const requested = useRef(new Set<string>());

  useEffect(() => {
    const keys = new Set(wanted.values());
    for (const [id, key] of wanted) {
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      const version = key.slice(key.lastIndexOf(':') + 1);
      void loadSessionAvatar(id, version).then(
        (url) => setLoaded((previous) => ({ ...previous, [key]: url })),
        // A missing image leaves the initials in place; the next icon version retries.
        () => undefined,
      );
    }
    setLoaded((previous) => {
      const stale = Object.keys(previous).filter((key) => !keys.has(key));
      if (stale.length === 0) return previous;
      const next = { ...previous };
      for (const key of stale) {
        URL.revokeObjectURL(next[key]!);
        delete next[key];
        requested.current.delete(key);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wanted` is rebuilt each render; `wantedKey` tracks its content.
  }, [wantedKey]);

  useEffect(
    () => () => {
      setLoaded((previous) => {
        for (const url of Object.values(previous)) URL.revokeObjectURL(url);
        return {};
      });
    },
    [],
  );

  const urls: Record<string, string> = {};
  for (const [id, key] of wanted) {
    const url = loaded[key];
    if (url !== undefined) urls[id] = url;
  }
  return urls;
}

/**
 * The session rail as data and actions for the active template.
 *
 * Owns what must keep working whichever template renders (or hides) the rail:
 * the status clock, workspace hydration, the Ctrl+T and 1-9 shortcuts, and the
 * actions that reach the hub and the router.
 */
export function useSessionRail({ onDismiss }: { onDismiss?: () => void }): WebTemplateRail {
  const navigate = useNavigate();
  const order = useStore(sessionsStore, (state) => state.order);
  const byId = useStore(sessionsStore, (state) => state.byId);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const workspaceOrder = useStore(workspacesStore, (state) => state.order);
  const workspacesById = useStore(workspacesStore, (state) => state.byId);
  const selectedWorkspaceId = useStore(workspacesStore, (state) => state.selectedId);
  const workspacesHydrated = useStore(workspacesStore, (state) => state.hydrated);
  const hasDialog = useStore(sessionStoreFor(activeId), (state) => state.dialog !== null);
  const remote = useStore(remoteAccessStore, (state) => state.view);
  const creating = useStore(newSessionStore, (state) => state);
  const [now, setNow] = useState(() => Date.now());
  const [restarts, setRestarts] = useState<Readonly<Record<string, RailRestartState>>>({});
  const avatarUrls = useSessionAvatars(order, byId);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (workspacesHydrated) return;
    let stale = false;
    void listWorkspaces().then((result) => {
      if (!stale && 'workspaces' in result) applyWorkspacesSnapshot(result);
    });
    return () => {
      stale = true;
    };
  }, [workspacesHydrated]);

  useEffect(() => {
    const workspaceId = activeId === null ? undefined : byId[activeId]?.summary.workspaceId;
    if (workspaceId !== undefined && workspacesById[workspaceId] !== undefined) selectWorkspace(workspaceId);
  }, [activeId, byId, workspacesById]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 't') {
        event.preventDefault();
        onDismiss?.();
        openNewSession(selectedWorkspaceId);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isEditable(event.target) || insideOverlay(event.target) || paletteStore.state.open || hasDialog) return;
      const ordinal = Number.parseInt(event.key, 10);
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 9) return;
      const target = order[ordinal - 1];
      if (target === undefined) return;
      event.preventDefault();
      onDismiss?.();
      void navigate({ to: '/session/$sessionId', params: { sessionId: target } });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [order, hasDialog, navigate, onDismiss, selectedWorkspaceId]);

  const workspaces = useMemo(
    () =>
      buildRailWorkspaces({
        order,
        byId,
        activeId,
        workspaceOrder,
        workspacesById,
        nested: new Set(order.filter((id) => resolveParentId(byId, id) !== undefined)),
        now,
        restarts,
        avatarUrls,
      }),
    [order, byId, activeId, workspaceOrder, workspacesById, now, restarts, avatarUrls],
  );

  const addingWorkspace =
    creating.open && (creating.workspaceId === null || workspacesById[creating.workspaceId] === undefined);

  return {
    workspaces,
    remote: {
      status: remote?.status ?? 'off',
      deviceCount: remote?.devices.length ?? 0,
      ...(remote?.publicUrl === undefined ? {} : { host: new URL(remote.publicUrl).host }),
      ...(remote?.error === undefined ? {} : { error: remote.error }),
    },
    pluginContent: <PluginSurface slot={HOST_SLOTS.rail} sessionId={activeId} />,
    ...(addingWorkspace ? { addWorkspace: { suggestedPaths: remote?.settings.sandbox.workspaces ?? [] } } : {}),
    actions: {
      openSession(sessionId) {
        onDismiss?.();
        void navigate({ to: '/session/$sessionId', params: { sessionId } });
      },
      renameSession(sessionId, name) {
        const trimmed = name.trim();
        if (trimmed !== '' && trimmed !== byId[sessionId]?.summary.name) renameSession(trimmed, sessionId);
      },
      restartSession(sessionId) {
        setRestarts((previous) => ({ ...previous, [sessionId]: { restarting: true } }));
        void restartSession(sessionId).then((result) => {
          if ('error' in result) {
            setRestarts((previous) => ({ ...previous, [sessionId]: { restarting: false, error: result.error } }));
            return;
          }
          // The hub synced before the replacement started, so the bundle this page
          // is running may be a build behind, and its socket has been replaced
          // underneath it either way. Reloading settles both.
          globalThis.location.reload();
        });
      },
      async removeSession(sessionId) {
        const result = await stopSession(sessionId);
        if ('error' in result) return { error: result.error };
        applySessionRemoved({ sessionId });
        return undefined;
      },
      resumeSession(sessionId) {
        openResumeDialog({ sessionId });
      },
      createSession(workspaceId) {
        selectWorkspace(workspaceId);
        onDismiss?.();
        openNewSession(workspaceId);
      },
      resumeInWorkspace(workspaceId) {
        openResumeDialog({ workspaceId });
      },
      openWorkspaceSettings(workspaceId) {
        selectWorkspace(workspaceId);
        onDismiss?.();
        void navigate({
          to: '/settings/$section',
          params: { section: DEFAULT_REPOSITORY_SETTINGS_SECTION },
          search: { workspace: workspaceId },
        });
      },
      async deleteWorkspace(workspaceId) {
        const result = await removeWorkspace(workspaceId);
        if ('error' in result) return { error: result.error };
        applyWorkspaceRemoved({ workspaceId });
        return undefined;
      },
      openAddWorkspace() {
        onDismiss?.();
        openNewSession(null);
      },
      closeAddWorkspace: closeNewSession,
      async addWorkspace({ name, path }) {
        const root = path?.trim();
        const label = name.trim();
        const outcome = await admitWorkspace({
          ...(root ? { root } : {}),
          ...(label ? { name: label } : {}),
        });
        if ('error' in outcome) return { error: outcome.error };
        applyWorkspaceUpsert({ workspace: outcome.workspace });
        selectWorkspace(outcome.workspace.id);
        closeNewSession();
        return undefined;
      },
      searchDirectories,
      listDirectory,
      async removePendingSetup(sessionId, setupId) {
        const workspaceId = byId[sessionId]?.summary.workspaceId;
        if (workspaceId === undefined) return { error: 'This session belongs to no workspace.' };
        const result = await removeSessionMcpSetup(workspaceId, sessionId, setupId);
        return 'error' in result ? { error: result.error } : undefined;
      },
      openSettings() {
        onDismiss?.();
        void navigate({
          to: '/settings/$section',
          params: { section: DEFAULT_SETTINGS_SECTION },
          search: { workspace: selectedWorkspaceId ?? undefined },
        });
      },
      openRemoteAccess() {
        onDismiss?.();
        openRemoteDialog();
      },
      turnRemoteAccessOff() {
        void turnRemoteAccessOff();
      },
      renderSessionMenuItems: (sessionId) => <PluginSurface slot={HOST_SLOTS.sessionMenu} sessionId={sessionId} />,
    },
  };
}
