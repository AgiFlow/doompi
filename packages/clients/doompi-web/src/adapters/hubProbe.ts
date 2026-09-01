const HEALTH_ROUTE = '/api/health';
const HUB_ROLE = 'hub';
const PROBE_TIMEOUT_MS = 1000;

/**
 * True when a DoomPi cockpit hub already answers on the address.
 *
 * The cockpit is a multi-session hub, so a second one is never what someone
 * wants: running `doompi-web` again should hand back the running cockpit
 * rather than fail on a port clash. Anything else answering the port is not a
 * hub and must not be mistaken for one, which is why the role is checked and
 * not just the status code.
 */
export interface HubDescriptor {
  /** Absent on a hub older than the field, which is itself a version mismatch. */
  version?: string;
  /** Absent when the hub does not report it; a restart then has nothing to signal. */
  pid?: number;
  sessions: number;
}

/**
 * Describes the hub answering the address, or undefined when none does.
 *
 * The version and pid travel with the answer so a caller can tell a duplicate
 * launch apart from an upgrade that needs the old process to step aside.
 */
export async function probeHub(host: string, port: number): Promise<HubDescriptor | undefined> {
  try {
    const response = await fetch(`http://${host}:${String(port)}${HEALTH_ROUTE}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      ok?: boolean;
      role?: string;
      version?: string;
      pid?: number;
      sessions?: number;
    };
    if (body.ok !== true || body.role !== HUB_ROLE) return undefined;
    return {
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(Number.isSafeInteger(body.pid) && Number(body.pid) > 0 ? { pid: Number(body.pid) } : {}),
      sessions: Number.isSafeInteger(body.sessions) && Number(body.sessions) > 0 ? Number(body.sessions) : 0,
    };
  } catch {
    // Nothing listening, a timeout, or a body that is not the hub's: all mean
    // "no hub here", which is the caller's cue to start one.
    return undefined;
  }
}

export async function hubAnswers(host: string, port: number): Promise<boolean> {
  return (await probeHub(host, port)) !== undefined;
}
