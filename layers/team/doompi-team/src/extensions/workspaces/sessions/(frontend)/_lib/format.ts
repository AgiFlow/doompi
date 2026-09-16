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

/**
 * What to call a run on screen.
 *
 * Prefers the generated identity, because a fan-out of one agent otherwise
 * renders as N rows reading the same word. Falls back to the agent name for a
 * run projected before identities existed. Duplicated rather than imported
 * from `services/agentIdentity`, which reaches for `node:fs` and so cannot be
 * pulled into the browser bundle; that module owns minting, this owns display.
 */
export function agentRunLabel(run: { agent: string; identity?: string; inline?: boolean }): string {
  const base = run.identity ?? run.agent;
  return run.inline ? `${base} (inline)` : base;
}
