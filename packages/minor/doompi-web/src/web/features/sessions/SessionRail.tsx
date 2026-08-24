import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { stopSession } from '../../lib/hubApi.ts';
import { abbreviateCwd, runningCount, sessionStatusLine } from '../../lib/sessionSummary.ts';
import { paletteStore } from '../../stores/paletteStore.ts';
import { renameSession, sessionStoreFor } from '../../stores/sessionStore.ts';
import { sessionsStore, type SessionMeta } from '../../stores/sessionsStore.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const STATUS_REFRESH_MS = 30_000;

function BranchIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 10 10" className={`h-[10px] w-[10px] shrink-0 ${className}`} aria-hidden>
      <circle cx="2.5" cy="2" r="1.3" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="2.5" cy="8" r="1.3" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="7.5" cy="3.5" r="1.3" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 3.3 V6.7 M7.5 4.8 Q7.5 6.5 4 6.8" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden>
      <path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden>
      <circle cx="6" cy="2.5" r="1.1" fill="currentColor" />
      <circle cx="6" cy="6" r="1.1" fill="currentColor" />
      <circle cx="6" cy="9.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

/**
 * What the card is doing besides showing its session: nothing, showing its
 * action menu, taking a new name, or asking before a stop.
 */
type CardMode = 'view' | 'menu' | 'rename' | 'confirm';

/** The confirmation that stands between the "remove" menu item and the stop. */
function RemoveSessionDialog({
  sessionId,
  name,
  onConfirm,
  onCancel,
}: {
  sessionId: string;
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-doom-deep/70" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal
        data-testid={`session-stop-dialog-${sessionId}`}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[360px] overflow-hidden rounded-lg border border-doom-border bg-doom-panel shadow-2xl"
      >
        <div className="border-b border-doom-border px-4 py-3">
          <span className="text-[12px] font-bold tracking-wide text-doom-hi">remove session</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="text-[11px] leading-relaxed text-doom-dim">
            this stops <span className="font-bold text-doom-hi">{name || 'untitled'}</span> and removes it from the
            rail. anything it is running ends now.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid={`session-stop-cancel-${sessionId}`}
              autoFocus
              onClick={onCancel}
              className="rounded border border-doom-border px-3 py-1 text-[11px] text-doom-dim hover:text-doom-hi"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid={`session-stop-confirm-${sessionId}`}
              onClick={onConfirm}
              className="rounded bg-doom-red px-3 py-1 text-[11px] font-bold text-doom-rail"
            >
              remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionCard({
  meta,
  ordinal,
  active,
  now,
}: {
  meta: SessionMeta;
  ordinal: number;
  active: boolean;
  now: number;
}) {
  const navigate = useNavigate();
  const summary = meta.summary;
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
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

  // The menu closes on a click anywhere else or on escape, like any popover.
  useEffect(() => {
    if (mode !== 'menu') return;
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) setMode('view');
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMode('view');
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [mode]);

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

  const cardClass = `flex w-full flex-col gap-1 rounded-md px-[11px] py-2.5 text-left ${
    active ? 'bg-[#2257A0]' : 'hover:bg-doom-panel'
  }`;
  const menuOpen = mode === 'menu';
  const menuButtonClass = `flex h-5 w-5 items-center justify-center rounded ${
    active
      ? 'text-white/80 hover:bg-white/20 hover:text-white'
      : 'text-doom-faint hover:bg-doom-deep hover:text-doom-hi'
  } ${menuOpen ? (active ? 'bg-white/20 text-white' : 'bg-doom-deep text-doom-hi') : ''}`;
  const menuItemClass = 'w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-doom-deep';
  const details = (
    <>
      <span
        data-testid="session-card-status"
        className={`text-[11px] leading-snug ${active ? 'line-clamp-2 text-[#DDE9FA]' : 'truncate text-doom-dim'}`}
      >
        {status}
      </span>
      {summary.git ? (
        <span
          data-testid="session-card-branch"
          className={`flex items-center gap-[7px] pt-0.5 text-[10px] ${active ? 'text-[#DDE9FA]' : 'text-doom-faint'}`}
        >
          <BranchIcon className={active ? 'text-white/70' : 'text-doom-faint'} />
          {summary.git.branch}
          {summary.git.dirty ? '*' : ''}
        </span>
      ) : null}
      <span className={`truncate text-[10px] ${active ? 'text-[#B9D3F2]' : 'text-doom-faint'}`}>
        {abbreviateCwd(summary.cwd)}
      </span>
      {error ? (
        <span data-testid="session-card-error" className="text-[10px] text-doom-red">
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
        <div className={cardClass}>
          <input
            data-testid={`session-name-input-${summary.id}`}
            value={draft}
            autoFocus
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') setMode('view');
            }}
            onBlur={() => setMode('view')}
            className="min-w-0 rounded border border-doom-blue/60 bg-doom-deep px-1.5 py-0.5 text-[13px] font-bold text-doom-hi outline-none"
          />
          {details}
        </div>
      ) : (
        <button
          type="button"
          data-testid={`session-open-${summary.id}`}
          onClick={() => void navigate({ to: '/session/$sessionId', params: { sessionId: summary.id } })}
          className={cardClass}
        >
          <div className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-[13px] font-bold ${active ? 'text-white' : 'text-doom-hi'}`}>
              {summary.name || 'untitled'}
            </span>
            {ordinal <= 9 ? (
              <span
                className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold group-focus-within:opacity-0 group-hover:opacity-0 ${
                  active ? 'bg-white/20 text-white' : 'bg-[#2E2136] text-doom-magenta'
                }`}
              >
                {ordinal}
              </span>
            ) : null}
          </div>
          {details}
        </button>
      )}

      {mode === 'view' || menuOpen ? (
        <div
          ref={menuRef}
          className={`absolute top-2 right-2 ${
            menuOpen ? 'z-10 opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          }`}
        >
          <button
            type="button"
            data-testid={`session-menu-${summary.id}`}
            title="session actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMode(menuOpen ? 'view' : 'menu')}
            className={menuButtonClass}
          >
            <KebabIcon />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              data-testid={`session-menu-list-${summary.id}`}
              className="absolute top-full right-0 mt-1 flex w-[120px] flex-col overflow-hidden rounded border border-doom-border bg-doom-panel py-1 shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                data-testid={`session-rename-${summary.id}`}
                onClick={beginRename}
                className={`${menuItemClass} text-doom-hi`}
              >
                edit
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`session-stop-${summary.id}`}
                onClick={() => setMode('confirm')}
                className={`${menuItemClass} text-doom-red`}
              >
                remove
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {mode === 'confirm' ? (
        <RemoveSessionDialog
          sessionId={summary.id}
          name={summary.name}
          onConfirm={() => void stop()}
          onCancel={() => setMode('view')}
        />
      ) : null}
    </div>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** The mockup's rail: brand, live session cards, the new-session flow, and nothing else. */
export function SessionRail() {
  const navigate = useNavigate();
  const order = useStore(sessionsStore, (state) => state.order);
  const byId = useStore(sessionsStore, (state) => state.byId);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const hasDialog = useStore(sessionStoreFor(activeId), (state) => state.dialog !== null);
  const [creating, setCreating] = useState(false);
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
        setCreating(true);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target) || paletteStore.state.open || hasDialog) return;
      const ordinal = Number.parseInt(event.key, 10);
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 9) return;
      const target = order[ordinal - 1];
      if (target === undefined) return;
      event.preventDefault();
      void navigate({ to: '/session/$sessionId', params: { sessionId: target } });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [order, hasDialog, navigate]);

  const running = runningCount(order.map((id) => byId[id].summary.phase));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-[9px] border-b border-doom-border px-4 pt-4 pb-3.5">
        <span className="text-[15px] font-bold tracking-[0.16em] text-doom-hi">DOOMPI</span>
        <span className="rounded-[3px] bg-[#2E2136] px-1.5 py-[3px] text-[8px] font-bold tracking-[0.12em] text-doom-magenta">
          WEB
        </span>
      </div>

      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <span className="text-[9px] font-bold tracking-[0.18em] text-doom-faint">SESSIONS</span>
        <span data-testid="sessions-running-rail" className="text-[9px] text-doom-faint">
          {running} running
        </span>
      </div>
      <div className="flex flex-col gap-1 px-2.5">
        {order.map((id, index) => (
          <SessionCard key={id} meta={byId[id]} ordinal={index + 1} active={id === activeId} now={now} />
        ))}
      </div>
      <div className="px-2.5 pt-2">
        <button
          type="button"
          data-testid="new-session-open"
          onClick={() => setCreating(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-doom-border px-[11px] text-[11px] text-doom-dim hover:border-doom-blue/50 hover:text-doom-hi"
        >
          <PlusIcon />
          new session
        </button>
      </div>

      <PluginSurface slot="rail" sessionId={activeId} />
      <div className="flex-1" />
      <div className="border-t border-doom-border px-4 py-3">
        <span className="text-[9px] text-doom-faint">ctrl+k commands · ctrl+t new session</span>
      </div>

      {creating ? <NewSessionDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
