import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { abbreviateCwd, runningCount, sessionStatusLine } from '../../lib/sessionSummary.ts';
import { paletteStore } from '../../stores/paletteStore.ts';
import { sessionStoreFor } from '../../stores/sessionStore.ts';
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

  return (
    <button
      type="button"
      data-testid={`session-card-${summary.id}`}
      data-active={active}
      onClick={() => void navigate({ to: '/session/$sessionId', params: { sessionId: summary.id } })}
      className={`flex w-full flex-col gap-1 rounded-md px-[11px] py-2.5 text-left ${
        active ? 'bg-[#2257A0]' : 'hover:bg-doom-panel'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[13px] font-bold ${active ? 'text-white' : 'text-doom-hi'}`}>
          {summary.name || 'untitled'}
        </span>
        {ordinal <= 9 ? (
          <span
            className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
              active ? 'bg-white/20 text-white' : 'bg-[#2E2136] text-doom-magenta'
            }`}
          >
            {ordinal}
          </span>
        ) : null}
      </div>
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
    </button>
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
