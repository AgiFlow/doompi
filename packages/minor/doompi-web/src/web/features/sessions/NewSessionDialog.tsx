import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import { createSession } from '../../lib/hubApi.ts';
import { sessionsStore, waitForSession } from '../../stores/sessionsStore.ts';

/**
 * Creates a session the way ctrl+t promises: pick a directory, get an agent.
 *
 * The recent-cwd chips are just the distinct directories of live sessions;
 * nothing is persisted, because the rail already is the user's working set.
 */
export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const byId = useStore(sessionsStore, (state) => state.byId);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const [cwd, setCwd] = useState(() => (activeId !== null ? (byId[activeId]?.summary.cwd ?? '') : ''));
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const recentCwds = [...new Set(Object.values(byId).map((meta) => meta.summary.cwd))].slice(0, 4);

  const submit = async (): Promise<void> => {
    if (busy || !cwd.trim()) return;
    setBusy(true);
    setError('');
    const outcome = await createSession({ cwd: cwd.trim(), name: name.trim() || undefined });
    if ('sessionId' in outcome) {
      // Navigating before the hub's upsert lands would bounce off the
      // unknown-session fallback; wait until the rail knows the session.
      const appeared = await waitForSession(outcome.sessionId);
      if (appeared) {
        onClose();
        await navigate({ to: '/session/$sessionId', params: { sessionId: outcome.sessionId } });
        return;
      }
      setError('The session was created but has not appeared yet; it will show up in the rail.');
      setBusy(false);
      return;
    }
    setError(outcome.error);
    setBusy(false);
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-doom-deep/70">
      <div
        data-testid="new-session-dialog"
        className="w-[440px] overflow-hidden rounded-lg border border-doom-border bg-doom-panel shadow-2xl"
      >
        <div className="border-b border-doom-border px-4 py-3">
          <span className="text-[12px] font-bold tracking-wide text-doom-hi">new session</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-doom-faint">working directory</span>
            <input
              data-testid="new-session-cwd"
              value={cwd}
              autoFocus
              onChange={(event) => setCwd(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
                if (event.key === 'Escape') onClose();
              }}
              placeholder="/absolute/path/to/project"
              className="rounded border border-doom-border bg-doom-deep px-2.5 py-1.5 text-[12px] text-doom-hi outline-none placeholder:text-doom-faint focus:border-doom-blue/60"
            />
          </label>
          {recentCwds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {recentCwds.map((recent) => (
                <button
                  key={recent}
                  type="button"
                  data-testid="new-session-recent"
                  onClick={() => setCwd(recent)}
                  className="rounded border border-doom-border px-1.5 py-0.5 text-[9px] text-doom-dim hover:border-doom-blue/50 hover:text-doom-hi"
                >
                  {recent}
                </button>
              ))}
            </div>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-doom-faint">name (optional)</span>
            <input
              data-testid="new-session-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
                if (event.key === 'Escape') onClose();
              }}
              placeholder="untitled"
              className="rounded border border-doom-border bg-doom-deep px-2.5 py-1.5 text-[12px] text-doom-hi outline-none placeholder:text-doom-faint focus:border-doom-blue/60"
            />
          </label>
          {error ? (
            <p data-testid="new-session-error" className="text-[10px] leading-relaxed text-doom-red">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="new-session-cancel"
              onClick={onClose}
              className="rounded border border-doom-border px-3 py-1 text-[11px] text-doom-dim hover:text-doom-hi"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="new-session-create"
              onClick={() => void submit()}
              disabled={busy || !cwd.trim()}
              className="rounded bg-doom-blue px-3 py-1 text-[11px] font-bold text-doom-rail disabled:opacity-40"
            >
              {busy ? 'creating…' : 'create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
