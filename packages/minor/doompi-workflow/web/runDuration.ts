/**
 * Local copy of the host's formatRunDuration (src/web/lib/sessionSummary.ts):
 * this plugin keeps zero host-lib imports so its later move into the owning
 * package is a file relocation.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatRunDuration(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return '<1m';
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  const hours = Math.floor(elapsedMs / HOUR_MS);
  const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
