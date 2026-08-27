import {
  BranchIcon,
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogBody,
  CloseIcon,
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
  SectionLabel,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@agimon-ai/doompi-web-components';
import { Link, useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { MascotMark } from '../../components/MascotMark.tsx';
import { RemoteAccessButton } from '../../components/RemoteAccessButton.tsx';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { HOST_SLOTS } from '../../lib/pluginRegistry.ts';
import { restartSession, stopSession } from '../../lib/hubApi.ts';
import { abbreviateCwd, runningCount, sessionStatusLine } from '../../lib/sessionSummary.ts';
import { DEFAULT_SETTINGS_SECTION } from '../../lib/settingsSections.ts';
import { closeNewSession, openNewSession, newSessionStore } from '../../stores/newSessionStore.ts';
import { paletteStore } from '../../stores/paletteStore.ts';
import { renameSession, sessionStoreFor } from '../../stores/sessionStore.ts';
import { sessionsStore, type SessionMeta } from '../../stores/sessionsStore.ts';
import { openRemoteDialog, remoteAccessStore } from '../../stores/remoteAccessStore.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const STATUS_REFRESH_MS = 30_000;

/**
 * What the card is doing besides showing its session: nothing, showing its
 * action menu, taking a new name, or asking before a stop.
 */
type CardMode = 'view' | 'menu' | 'rename' | 'confirm';

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
            rail. anything it is running ends now.
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
}: {
  meta: SessionMeta;
  ordinal: number;
  active: boolean;
  now: number;
  onNavigate?: () => void;
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
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const status = sessionStatusLine(
    {
      attach: meta.attach,
      phase: summary.phase,
      phaseSince: summary.phaseSince,
      awaitingInput: summary.awaitingInput,
      everPrompted: summary.everPrompted,
      lastSettledAt: summary.lastSettledAt,
    },
    now,
  );

  const beginRename = (): void => {
    setDraft(summary.name);
    setError('');
    setMode('rename');
  };
  const commitRename = (): void => {
    const name = draft.trim();
    if (name && name !== summary.name) renameSession(name, summary.id);
    setMode('view');
  };
  const stop = async (): Promise<void> => {
    setMode('view');
    const result = await stopSession(summary.id);
    if ('error' in result) setError(result.error);
  };
  const restart = async (): Promise<void> => {
    setMode('view');
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

  const cardClass = active ? 'bg-doom-selected hover:bg-doom-selected' : 'hover:bg-doom-panel';
  const menuOpen = mode === 'menu';
  const details = (
    <>
      <span
        data-testid="session-status"
        className={`text-[11px] leading-snug ${active ? 'line-clamp-2 text-doom-on-selected/85' : 'truncate text-doom-dim'}`}
      >
        {restarting ? 'restarting…' : status}
      </span>
      {summary.git ? (
        <span
          data-testid="session-branch"
          className={`flex items-center gap-[7px] pt-0.5 text-[10px] ${active ? 'text-doom-on-selected/85' : 'text-doom-faint'}`}
        >
          <BranchIcon
            className={`h-[10px] w-[10px] shrink-0 ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}
          />
          {summary.git.branch}
          {summary.git.dirty ? '*' : ''}
        </span>
      ) : null}
      <span className={`truncate text-[10px] ${active ? 'text-doom-on-selected/70' : 'text-doom-faint'}`}>
        {abbreviateCwd(summary.cwd)}
      </span>
      {error ? (
        <span data-testid="session-error" className="line-clamp-3 text-[10px] break-words text-doom-red">
          {error}
        </span>
      ) : null}
    </>
  );

  return (
    <div className="group relative" data-testid={`session-card-${summary.id}`} data-active={active}>
      {mode === 'rename' ? (
        // The name field cannot live inside the card button, so the card
        // briefly stops being one while it takes a name.
        <div className={cn(buttonVariants({ variant: 'ghost', size: 'card' }), cardClass, 'cursor-default')}>
          <Input
            data-testid={`session-name-input-${summary.id}`}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') setMode('view');
            }}
            onBlur={() => setMode('view')}
            className="border-doom-blue/60 px-1.5 py-0.5 text-[13px] font-bold"
          />
          {details}
        </div>
      ) : (
        <Button
          variant="ghost"
          size="card"
          data-testid={`session-open-${summary.id}`}
          onClick={() => {
            onNavigate?.();
            void navigate({ to: '/session/$sessionId', params: { sessionId: summary.id } });
          }}
          className={cardClass}
        >
          <div className="flex items-center gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-[13px] font-bold ${active ? 'text-doom-on-selected' : 'text-doom-hi'}`}
            >
              {summary.name || 'untitled'}
            </span>
            {ordinal <= 9 ? (
              <span
                title={`press ${String(ordinal)} to focus`}
                className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 ${
                  active ? 'bg-doom-on-selected/20 text-doom-on-selected' : 'bg-doom-tint-magenta text-doom-magenta'
                }`}
              >
                {ordinal}
              </span>
            ) : null}
          </div>
          {details}
        </Button>
      )}

      {mode === 'view' || menuOpen ? (
        <div
          className={`absolute top-2 right-2 transition-opacity ${
            menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          }`}
        >
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(next) => setMode((current) => (next ? 'menu' : current === 'menu' ? 'view' : current))}
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
              <DropdownMenuItem data-testid={`session-rename-${summary.id}`} onSelect={beginRename}>
                edit
              </DropdownMenuItem>
              {/* Syncs, replaces the session's server under the same id, and
                  reloads the page: the one way a rebuilt extension or a newly
                  declared package API reaches a session that is already up. */}
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
                onSelect={() => setMode('confirm')}
              >
                remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      <RemoveSessionDialog
        sessionId={summary.id}
        name={summary.name}
        open={mode === 'confirm'}
        onConfirm={() => void stop()}
        onCancel={() => setMode('view')}
      />
    </div>
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

/** The mockup's rail: brand, live session cards, the new-session flow, and nothing else. */
export function SessionRail({ onDismiss }: { onDismiss?: () => void }) {
  const navigate = useNavigate();
  const order = useStore(sessionsStore, (state) => state.order);
  const byId = useStore(sessionsStore, (state) => state.byId);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const hasDialog = useStore(sessionStoreFor(activeId), (state) => state.dialog !== null);
  const remote = useStore(remoteAccessStore, (state) => state.view);
  // Shared, because the welcome panel in the other column opens the same
  // dialog and a feature may not reach into a sibling.
  const creating = useStore(newSessionStore, (state) => state.open);
  const [now, setNow] = useState(() => Date.now());

  // Keeps "running · 12m" honest without any frame arriving.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 't') {
        event.preventDefault();
        onDismiss?.();
        openNewSession();
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
  }, [order, hasDialog, navigate, onDismiss]);

  const running = runningCount(order.map((id) => byId[id].summary.phase));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-doom-border px-4 pt-4 pb-3.5">
        <span className="flex items-center gap-[3px]" aria-label="DoomPi">
          <span aria-hidden="true" className="text-[15px] font-bold tracking-[0.16em] text-doom-hi">
            DOOM
          </span>
          <MascotMark size={22} />
        </span>
        <span className="flex items-center gap-1">
          {/* A presentational trigger taking state and one callback, so the rail
              never imports the remote feature, which no-cross-feature-import
              forbids. The dialog it opens is mounted once at the app root. */}
          <RemoteAccessButton
            status={remote?.status ?? 'off'}
            deviceCount={remote?.devices.length ?? 0}
            onOpen={() => {
              onDismiss?.();
              openRemoteDialog();
            }}
          />
          {onDismiss ? (
            <Button
              variant="ghost"
              size="icon"
              data-testid="mobile-sessions-close"
              title="hide sessions"
              aria-label="hide sessions"
              onClick={onDismiss}
              className="text-doom-dim md:hidden"
            >
              <CloseIcon className="h-3 w-3" />
            </Button>
          ) : null}
        </span>
      </div>

      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <SectionLabel>sessions</SectionLabel>
        <span className="flex items-center gap-2.5">
          <span data-testid="sessions-running-rail" className="text-[9px] text-doom-faint">
            {running} running
          </span>
          {/* The rail's own action lives in its heading, where a heading's
              action belongs, instead of a full-width button competing with the
              cards for the eye. */}
          <Button
            variant="ghost"
            size="icon"
            data-testid="new-session-open"
            title="new session"
            aria-label="new session"
            onClick={() => {
              onDismiss?.();
              openNewSession();
            }}
            className="text-doom-faint hover:text-doom-hi"
          >
            <PlusIcon className="h-3 w-3" />
          </Button>
        </span>
      </div>
      <div className="flex flex-col gap-1 px-2.5">
        {order.map((id, index) => (
          <SessionCard
            key={id}
            meta={byId[id]}
            ordinal={index + 1}
            active={id === activeId}
            now={now}
            onNavigate={onDismiss}
          />
        ))}
      </div>
      {/* With no sessions the rail has nothing to show and the plus alone is a
          thin invitation, so the empty state spells the action out. */}
      {order.length === 0 ? (
        <div className="px-2.5 pt-2">
          <Button
            variant="outline"
            size="lg"
            data-testid="new-session-empty"
            onClick={() => {
              onDismiss?.();
              openNewSession();
            }}
            className="w-full justify-start px-[11px] text-[11px]"
          >
            <PlusIcon className="h-3 w-3" />
            new session
          </Button>
        </div>
      ) : null}

      <PluginSurface slot={HOST_SLOTS.rail} sessionId={activeId} />
      <div className="flex-1" />
      <div className="flex items-center gap-2.5 border-t border-doom-border px-4 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon" className="text-doom-faint">
              <Link
                to="/settings/$section"
                params={{ section: DEFAULT_SETTINGS_SECTION }}
                data-testid="settings-open"
                aria-label="settings"
                onClick={onDismiss}
              >
                <GearIcon className="h-3 w-3" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">settings</TooltipContent>
        </Tooltip>
        <span className="text-[9px] text-doom-faint max-sm:hidden">ctrl+k commands · ctrl+t new session</span>
      </div>

      {creating ? (
        <NewSessionDialog onClose={closeNewSession} suggestedCwds={remote?.settings.sandbox.workspaces ?? []} />
      ) : null}
    </div>
  );
}
