import fs from 'node:fs';
import { hubAdvertisementPath, parseHubAdvertisement } from '@agimon-ai/doompi-web-contracts';
import type { HubAdvertisement } from '@agimon-ai/doompi-web-contracts';

const HEALTH_ROUTE = '/api/health';
const SESSIONS_ROUTE = '/api/sessions';
const PROBE_TIMEOUT_MS = 1000;
/**
 * Creating a session is not a quick call.
 *
 * The hub validates, then runs `ensureSessionSynced`, then spawns. A cockpit
 * that has never synced the composition builds it first, which is minutes on a
 * cold cache, and a fresh worktree also installs its dependencies. A 30s
 * timeout was measured aborting a create that the hub then completed anyway,
 * leaving the caller told it failed while a session started behind it.
 */
const CREATE_TIMEOUT_MS = 600_000;
/** Stopping is just a signal and a record removal, so it stays short. */
const STOP_TIMEOUT_MS = 30_000;
const HUB_ROLE = 'hub';

/** Raised when the cockpit that owns session lifecycle is not reachable. */
export class HubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnavailableError';
  }
}

/**
 * Whether the hub still has a record for a session.
 *
 * The session server writes its record into the shared registry directory and
 * removes it on exit, so the file's presence is the liveness signal. A pid is
 * not available here: the hub spawns the process, so this package never learns
 * one, and a pid it invented would be a field that always lies.
 */
export function sessionIsLive(registryDir: string, sessionId: string): boolean {
  return fs.existsSync(`${registryDir}/sessions/${sessionId}.json`);
}

/**
 * Asks the hub to stop a session it started.
 *
 * Stopping is the hub's job for the same reason starting is. Signalling the
 * process directly would leave the hub's own record of it behind and race the
 * cleanup it does on the way down.
 *
 * A session the hub does not know about is already stopped, which is the
 * outcome the caller wanted, so a 404 is success.
 */
export async function stopWorktreeSession(registryDir: string, sessionId: string): Promise<void> {
  const advertisement = readHubAdvertisement(registryDir);
  if (advertisement === undefined) return;
  if (!(await hubAnswers(advertisement.url))) return;
  try {
    const response = await fetch(`${advertisement.url}${SESSIONS_ROUTE}/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new HubUnavailableError(
        body.error ?? `The cockpit could not stop the session (${String(response.status)}).`,
      );
    }
  } catch (error) {
    if (error instanceof HubUnavailableError) throw error;
    throw new HubUnavailableError(`Could not reach the cockpit: ${(error as Error).message}`);
  }
}

export interface CreateWorktreeSessionInput {
  /** The worktree directory; must already exist. */
  cwd: string;
  /** Rail display name for the new session. */
  name: string;
  /** The session asking for this one, so the rail can nest them. */
  parentSessionId: string;
  registryDir: string;
}

/** Reads the hub's published address, if it published one. */
export function readHubAdvertisement(registryDir: string): HubAdvertisement | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(hubAdvertisementPath(registryDir), 'utf8');
  } catch {
    return undefined;
  }
  return parseHubAdvertisement(raw);
}

/**
 * Confirms a live cockpit hub answers at the address, rather than a leftover.
 *
 * The advertisement file outlives a crash and a port gets reused, so finding it
 * proves nothing. Only a hub that answers /api/health and calls itself a hub is
 * worth sending a session-create to; anything else is something else's port.
 */
async function hubAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}${HEALTH_ROUTE}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean; role?: string };
    return body.ok === true && body.role === HUB_ROLE;
  } catch {
    return false;
  }
}

/**
 * Asks the cockpit hub to start a session in a worktree.
 *
 * The hub owns session lifecycle: it validates the directory, syncs the
 * composition, spawns the server and records the lineage. This package only
 * asks. Creating the process here instead would put a second spawn path beside
 * the hub's, with its own idea of what a session needs, and a session server is
 * bound to one session anyway so it has no business starting another.
 *
 * The panel and the agent both come through here, so there is one route to keep
 * correct rather than two that drift.
 */
export async function createWorktreeSession(input: CreateWorktreeSessionInput): Promise<string> {
  const advertisement = readHubAdvertisement(input.registryDir);
  if (advertisement === undefined) {
    throw new HubUnavailableError(
      'No cockpit is running. Worktree sessions are created by the cockpit, so start it and try again.',
    );
  }
  if (!(await hubAnswers(advertisement.url))) {
    throw new HubUnavailableError(
      `The cockpit that advertised ${advertisement.url} is no longer answering. Start it and try again.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${advertisement.url}${SESSIONS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: input.cwd,
        name: input.name,
        parentSessionId: input.parentSessionId,
        provenance: 'worktree',
      }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HubUnavailableError(`Could not reach the cockpit: ${(error as Error).message}`);
  }

  const body = (await response.json().catch(() => ({}))) as { sessionId?: string; error?: string };
  if (!response.ok) {
    throw new HubUnavailableError(body.error ?? `The cockpit refused the session (${String(response.status)}).`);
  }
  if (typeof body.sessionId !== 'string' || body.sessionId === '') {
    throw new HubUnavailableError('The cockpit accepted the session but did not name it.');
  }
  return body.sessionId;
}
