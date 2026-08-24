import { abbreviateCwd } from '../../lib/sessionSummary.ts';
import { useActiveSessionMeta } from '../../stores/sessionsStore.ts';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] text-doom-faint">{label}</span>
      <span className="truncate text-[10px] text-doom-text">{value}</span>
    </div>
  );
}

/**
 * Shown when the focused session will not take this cockpit.
 *
 * doompi-server holds one client at a time so two views cannot fight over the
 * same agent. The hub keeps retrying underneath, so this explains the wait
 * rather than offering a button that would do the same thing again. Other
 * sessions' refusals stay in their rail cards; only the focused one earns the
 * overlay.
 */
export function RefusedCard() {
  const meta = useActiveSessionMeta();
  if (meta === null || meta.attach !== 'refused') return null;

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-doom-deep/70">
      <div
        data-testid="refused-card"
        className="w-[520px] overflow-hidden rounded-lg border border-doom-red/50 bg-doom-panel shadow-2xl"
      >
        <div className="border-b border-doom-red/40 bg-doom-red/10 px-4 py-3">
          <span data-testid="refused-title" className="text-[12px] font-bold tracking-wide text-doom-red">
            session already attached
          </span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="text-[12px] leading-relaxed text-doom-text">
            doompi-server holds one client at a time so two views cannot fight over the same agent. Another cockpit is
            attached to this socket right now.
          </p>
          <div className="flex flex-col gap-1.5 rounded border border-doom-border bg-doom-deep px-3 py-2.5">
            <Detail label="reason" value={meta.reason || 'attach_error'} />
            <Detail label="socket" value={meta.summary.socketPath} />
            <Detail label="cwd" value={abbreviateCwd(meta.summary.cwd)} />
            <Detail label="retry" value="automatic, with backoff" />
          </div>
          <p data-testid="refused-hint" className="text-[10px] text-doom-faint">
            close the other cockpit and this one takes over on the next attempt.
          </p>
        </div>
      </div>
    </div>
  );
}
