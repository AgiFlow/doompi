import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GearIcon,
  Input,
  KebabIcon,
  PlusIcon,
} from '@agimon-ai/doompi-web-components';
import { Link, useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PluginSurface } from '../../components/PluginSurface';
import { RemoteAccessButton } from '../../components/RemoteAccessButton';
import { listWorkspaces, restartSession, stopSession } from '../../lib/hubApi';
import { HOST_SLOTS } from '../../lib/pluginRegistry';
import { sessionStatusLine } from '../../lib/sessionSummary';
import { DEFAULT_REPOSITORY_SETTINGS_SECTION, DEFAULT_SETTINGS_SECTION } from '../../lib/settingsSections';
import { closeNewSession, openNewSession, newSessionStore } from '../../stores/newSessionStore';
import { paletteStore } from '../../stores/paletteStore';
import { openRemoteDialog, remoteAccessStore, turnRemoteAccessOff } from '../../stores/remoteAccessStore';
import { applySessionRemoved, resolveParentId, sessionsStore, type SessionMeta } from '../../stores/sessionsStore';
import { renameSession, sessionStoreFor } from '../../stores/sessionStore';
import { applyWorkspacesSnapshot, selectWorkspace, workspacesStore } from '../../stores/workspacesStore';
import { AddWorkspaceDialog } from './AddWorkspaceDialog';
import { NewSessionDialog } from './NewSessionDialog';
import { PendingSessionCard } from './PendingSessionCard';
import { ResumeSessionDialog } from './ResumeSessionDialog';
import { SessionCardView, SessionRailView, WorkspaceGroupView } from './SessionRailView';
const STATUS_REFRESH_MS = 30_000;

/**
 * What the card is doing besides showing its session: nothing, showing its
 * action menu, taking a new name, browsing Pi history, or asking before a stop.
 */
type CardMode = 'view' | 'menu' | 'rename' | 'resume' | 'confirm';

/** The confirmation that stands between the "remove" menu item and the stop. */
function RemoveSessionDialog({
  sessionId,
  name,
  open,
  onConfirm,
  onCancel,
}: {
  sessionId: string;
  name: string;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent width="sm" data-testid={`session-stop-dialog-${sessionId}`} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>remove session</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            this stops <span className="font-bold text-doom-hi">{name || 'untitled'}</span> and removes it from the
            rail. anything it is running ends now, but its saved history remains available to resume.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              size="md"
              data-testid={`session-stop-cancel-${sessionId}`}
              autoFocus
              onClick={onCancel}
            >
              cancel
            </Button>
            <Button variant="danger" size="md" data-testid={`session-stop-confirm-${sessionId}`} onClick={onConfirm}>
              remove
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function SessionCard({
  meta,
  ordinal,
  active,
  now,
  onNavigate,
  nested = false,
}: {
  meta: SessionMeta;
  ordinal: number;
  active: boolean;
  now: number;
  onNavigate?: () => void;
  /** Rendered under its parent: one fixed indent, never multiplied by depth. */
  nested?: boolean;
}) {
  const navigate = useNavigate();
  const summary = meta.summary;
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  // A restart stops a process and waits for its replacement to register, which
  // takes seconds; without saying so the card just looks stuck.
  const [restarting, setRestarting] = useState(false);
  // Read when the menu closes: a choice that moved the card into another
  // mode keeps the focus it took, rather than handing it back to the kebab.
  // The menu's close-focus handler runs before React has re-rendered the card,
  // so the ref is written from the event that changes the mode, never during
  // render.
  const modeRef = useRef(mode);
  const enterMode = (next: CardMode): void => {
    modeRef.current = next;
    setMode(next);
  };
  const status = sessionStatusLine(
    {
      attach: meta.attach,
      phase: summary.phase,
      phaseSince: summary.phaseSince,
      awaitingInput: summary.awaitingInput,
      everPrompted: summary.everPrompted,
      lastSettledAt: summary.lastSettledAt,
      dormant: summary.dormant,
    },
    now,
  );
  // The same priority the status copy uses: a refusal outranks the question,
  // and a restarting card is describing the restart, not the run it ended.
  const awaitingInput = summary.awaitingInput && meta.attach !== 'refused' && !restarting;
  const beginRename = (): void => {
    setDraft(summary.name);
    setError('');
    enterMode('rename');
  };
  const commitRename = (): void => {
    const name = draft.trim();
    if (name && name !== summary.name) renameSession(name, summary.id);
    enterMode('view');
  };
  const stop = async (): Promise<void> => {
    enterMode('view');
    const result = await stopSession(summary.id);
    if ('error' in result) setError(result.error);
    else applySessionRemoved({ sessionId: summary.id });
  };
  const restart = async (): Promise<void> => {
    enterMode('view');
    setError('');
    setRestarting(true);
    const result = await restartSession(summary.id);
    if ('error' in result) {
      setRestarting(false);
      setError(result.error);
      return;
    }
    // The hub synced before the replacement started, so the bundle this page
    // is running may be a build behind, and its socket has been replaced
    // underneath it either way. Reloading settles both.
    globalThis.location.reload();
  };

  const menuOpen = mode === 'menu';
  const editing =
    mode === 'rename' ? (
      <Input
        data-testid={`session-name-input-${summary.id}`}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitRename();
          if (event.key === 'Escape') enterMode('view');
        }}
        onBlur={() => enterMode('view')}
        className="border-doom-blue/60 px-1.5 py-0.5 text-base font-bold"
      />
    ) : undefined;
  const menu =
    mode === 'view' || menuOpen ? (
      <div
        className={`absolute top-2 right-2 transition-opacity ${
          menuOpen ? 'opacity-100' : 'group-focus-within:opacity-100 group-hover:opacity-100'
        }`}
      >
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(next) => {
            const current = modeRef.current;
            enterMode(next ? 'menu' : current === 'menu' ? 'view' : current);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid={`session-menu-${summary.id}`}
              title="session actions"
              className={
                active
                  ? 'text-doom-on-selected/80 hover:bg-doom-on-selected/20 hover:text-doom-on-selected data-[state=open]:bg-doom-on-selected/20 data-[state=open]:text-doom-on-selected'
                  : 'text-doom-faint hover:bg-doom-deep hover:text-doom-hi data-[state=open]:bg-doom-deep data-[state=open]:text-doom-hi'
              }
            >
              <KebabIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            data-testid={`session-menu-list-${summary.id}`}
            onCloseAutoFocus={(event) => {
              if (modeRef.current !== 'view') event.preventDefault();
            }}
          >
            <PluginSurface slot={HOST_SLOTS.sessionMenu} sessionId={summary.id} />
            <DropdownMenuItem data-testid={`session-rename-${summary.id}`} onSelect={beginRename}>
              edit
            </DropdownMenuItem>
            <DropdownMenuItem data-testid={`session-resume-${summary.id}`} onSelect={() => enterMode('resume')}>
              resume
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={`session-restart-${summary.id}`}
              disabled={restarting}
              onSelect={() => void restart()}
            >
              restart
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              data-testid={`session-stop-${summary.id}`}
              onSelect={() => enterMode('confirm')}
            >
              remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) : null;

  return (
    <SessionCardView
      meta={meta}
      ordinal={ordinal}
      active={active}
      status={status}
      awaitingInput={awaitingInput}
      restarting={restarting}
      error={error || undefined}
      nested={nested}
      onOpen={() => {
        onNavigate?.();
        void navigate({ to: '/session/$sessionId', params: { sessionId: summary.id } });
      }}
      editing={editing}
      menu={
        <>
          {menu}
          {mode === 'resume' ? <ResumeSessionDialog sessionId={summary.id} onClose={() => enterMode('view')} /> : null}
          <RemoveSessionDialog
            sessionId={summary.id}
            name={summary.name}
            open={mode === 'confirm'}
            onConfirm={() => void stop()}
            onCancel={() => enterMode('view')}
          />
        </>
      }
    />
  );
}

function workspaceName(root: string): string {
  const trimmed = root.replace(/\/+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || root;
}

function WorkspaceSection({
  workspaceId,
  root,
  available,
  cards,
  hasSessions,
  onCreate,
  onOpenSettings,
}: {
  workspaceId: string;
  root: string;
  available: boolean;
  cards: ReactNode;
  hasSessions: boolean;
  onCreate: () => void;
  onOpenSettings: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  return (
    <WorkspaceGroupView
      workspaceId={workspaceId}
      name={workspaceName(root)}
      path={root}
      available={available}
      hasSessions={hasSessions}
      cards={cards}
      createAction={
        <Button
          variant="ghost"
          size="icon"
          data-testid={`workspace-new-session-${workspaceId}`}
          title="new session"
          aria-label={`new session in ${workspaceName(root)}`}
          disabled={!available}
          onClick={onCreate}
          className="text-doom-faint hover:text-doom-hi"
        >
          <PlusIcon className="h-3 w-3" />
        </Button>
      }
      menuAction={
        <>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid={`workspace-menu-${workspaceId}`}
                title="workspace actions"
                aria-label={`${workspaceName(root)} actions`}
                className="text-doom-faint hover:text-doom-hi"
              >
                <KebabIcon className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem disabled={!available} onSelect={() => setResumeOpen(true)}>
                resume session
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!available} onSelect={onOpenSettings}>
                workspace settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {resumeOpen ? <ResumeSessionDialog workspaceId={workspaceId} onClose={() => setResumeOpen(false)} /> : null}
        </>
      }
    />
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** A key pressed inside an overlay belongs to that overlay, never to the rail. */
function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"], [role="menu"], [role="alertdialog"]') !== null;
}

/** The workspace-first rail: durable roots own their live and resumable sessions. */
export function SessionRail({ onDismiss }: { onDismiss?: () => void }) {
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

  const groupedIds = new Set<string>();
  const ordinalById = new Map(order.map((id, index) => [id, index + 1]));
  const groups: ReactNode[] = workspaceOrder.map((workspaceId) => {
    const workspace = workspacesById[workspaceId];
    const ids = order.filter((id) => byId[id]?.summary.workspaceId === workspaceId);
    for (const id of ids) groupedIds.add(id);
    const cards = ids.flatMap((id) => [
      <SessionCard
        key={id}
        meta={byId[id]}
        ordinal={ordinalById.get(id) ?? 0}
        active={id === activeId}
        now={now}
        onNavigate={onDismiss}
        nested={resolveParentId(byId, id) !== undefined}
      />,
      ...(byId[id].summary.pendingSetups ?? []).map((setup) => (
        <PendingSessionCard key={`setup:${setup.id}`} parent={byId[id].summary} setup={setup} />
      )),
    ]);
    return (
      <WorkspaceSection
        key={workspaceId}
        workspaceId={workspaceId}
        root={workspace.root}
        available={workspace.available !== false}
        cards={cards}
        hasSessions={ids.length > 0}
        onCreate={() => {
          selectWorkspace(workspaceId);
          openNewSession(workspaceId);
        }}
        onOpenSettings={() => {
          selectWorkspace(workspaceId);
          onDismiss?.();
          void navigate({
            to: '/settings/$section',
            params: { section: DEFAULT_REPOSITORY_SETTINGS_SECTION },
            search: { workspace: workspaceId },
          });
        }}
      />
    );
  });
  const legacyIds = order.filter((id) => !groupedIds.has(id));
  if (legacyIds.length > 0) {
    const root = byId[legacyIds[0]].summary.cwd;
    groups.push(
      <WorkspaceSection
        key="legacy-workspace"
        workspaceId="legacy-workspace"
        root={root}
        available={false}
        hasSessions
        cards={legacyIds.map((id) => (
          <SessionCard
            key={id}
            meta={byId[id]}
            ordinal={ordinalById.get(id) ?? 0}
            active={id === activeId}
            now={now}
            onNavigate={onDismiss}
            nested={resolveParentId(byId, id) !== undefined}
          />
        ))}
        onCreate={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
  }

  const targetWorkspace = creating.workspaceId === null ? undefined : workspacesById[creating.workspaceId];
  return (
    <SessionRailView
      hasWorkspaces={groups.length > 0}
      workspaceGroups={groups}
      remote={remote}
      remoteAccessButton={
        <RemoteAccessButton
          status={remote?.status ?? 'off'}
          deviceCount={remote?.devices.length ?? 0}
          onOpen={() => {
            onDismiss?.();
            openRemoteDialog();
          }}
        />
      }
      railContent={<PluginSurface slot={HOST_SLOTS.rail} sessionId={activeId} />}
      settingsLink={
        <Button asChild variant="ghost" size="icon" className="text-doom-faint">
          <Link
            to="/settings/$section"
            params={{ section: DEFAULT_SETTINGS_SECTION }}
            search={{ workspace: selectedWorkspaceId ?? undefined }}
            data-testid="settings-open"
            aria-label="settings"
            onClick={onDismiss}
          >
            <GearIcon className="h-3 w-3" />
          </Link>
        </Button>
      }
      onDismiss={onDismiss}
      onOpenRemote={openRemoteDialog}
      onAddWorkspace={() => {
        onDismiss?.();
        openNewSession(null);
      }}
      onTurnRemoteOff={() => void turnRemoteAccessOff()}
    >
      {creating.open ? (
        targetWorkspace === undefined ? (
          <AddWorkspaceDialog onClose={closeNewSession} suggestedRoots={remote?.settings.sandbox.workspaces ?? []} />
        ) : (
          <NewSessionDialog
            workspaceId={targetWorkspace.id}
            workspaceRoot={targetWorkspace.root}
            onClose={closeNewSession}
          />
        )
      ) : null}
    </SessionRailView>
  );
}
