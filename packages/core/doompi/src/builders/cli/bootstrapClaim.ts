import path from 'node:path';

/**
 * Process-wide ownership of one repository's DoomPi load cycle.
 *
 * Pi unions the extension lists of its user and project settings scopes and
 * dedupes only by the resolved file's real path, so registering DoomPi in both
 * scopes loads two separate installs of the same package. Each one would
 * otherwise read, recompile, and rewrite the same home-scoped worktree state
 * for the same repository, and two installs at different versions disagree about the state
 * contract. A process-global symbol survives the distinct module URLs those
 * installs have, so the first factory owns the cycle and the rest stand down.
 * Pi resolves project resources before user ones, which makes the owner the
 * repository-local install whenever both scopes register the package.
 */

const BOOTSTRAP_CLAIM_KEY = Symbol.for('@agimon-ai/doompi:bootstrap-claim');

export type ReleaseBootstrapClaim = () => void;

/**
 * The registry shared by every DoomPi install in this process.
 *
 * The symbol description is part of the cross-install contract and must stay
 * exactly as written: two installs only meet here when they compute the same
 * key. A value of another shape belongs to an install that spelled the
 * registry differently, so this one starts its own rather than corrupting it.
 */
function claimRegistry(): Map<string, symbol> {
  const existing = Reflect.get(globalThis, BOOTSTRAP_CLAIM_KEY);
  if (existing instanceof Map) return existing as Map<string, symbol>;
  const created = new Map<string, symbol>();
  Reflect.set(globalThis, BOOTSTRAP_CLAIM_KEY, created);
  return created;
}

/**
 * Claims the load cycle for one repository, or reports that it is already owned.
 *
 * Callers must acquire before their first `await`, because releasing happens on
 * `session_start` and an interleaved second factory would otherwise slip in.
 */
export function acquireBootstrapClaim(repoRoot: string): ReleaseBootstrapClaim | undefined {
  const registry = claimRegistry();
  const key = path.resolve(repoRoot);
  if (registry.has(key)) return undefined;

  const claim = Symbol('doompi-bootstrap');
  registry.set(key, claim);
  return () => {
    if (registry.get(key) === claim) registry.delete(key);
  };
}
