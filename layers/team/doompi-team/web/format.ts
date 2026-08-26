/**
 * Local copies of the host cockpit's pure formatters
 * (doompi-web src/web/lib/sessionSummary.ts): this plugin ships zero host
 * imports so the cockpit's bundler can compile it from any install.
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

export function abbreviateCwd(cwd: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/u.exec(cwd);
  if (!match) return cwd;
  return `~${cwd.slice(match[0].length)}`;
}
