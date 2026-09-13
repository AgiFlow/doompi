import { DEV_PROXY_TARGETS_ROUTE, type DevProxyStateView, type DevProxyTarget } from '../../types/devProxy';
import { sealedHttpSession } from './sealedSession';

/**
 * The dev proxy control plane, seen from the browser.
 *
 * Every call goes through the sealed session for the same reason the rest of
 * the cockpit does: on a tunnel, an unsealed `/api/` request is refused. The
 * proxied dev site itself is the deliberate exception, and it never comes
 * through here, because the browser fetches those bytes on its own.
 */

const UNREACHABLE = 'The cockpit hub is unreachable.';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const NO_CONTENT = 204;

export type TargetsResult = { state: DevProxyStateView } | { error: string };
export type TargetResult = { target: DevProxyTarget } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // A body that is not JSON tells us nothing the status has not already.
  }
  return `The hub answered ${String(response.status)}.`;
}

export async function fetchDevProxyTargets(): Promise<TargetsResult> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(DEV_PROXY_TARGETS_ROUTE);
  } catch {
    return { error: UNREACHABLE };
  }
  if (!response.ok) return { error: await readError(response) };
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !Array.isArray(body.targets)) return { error: 'The hub sent no dev proxy targets.' };
  return {
    state: { targets: body.targets as DevProxyTarget[], canRegister: body.canRegister === true },
  };
}

export async function addDevProxyTarget(name: string, port: number): Promise<TargetResult> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(DEV_PROXY_TARGETS_ROUTE, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name, port }),
    });
  } catch {
    return { error: UNREACHABLE };
  }
  if (!response.ok) return { error: await readError(response) };
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !isRecord(body.target)) return { error: 'The hub did not confirm the target.' };
  return { target: body.target as unknown as DevProxyTarget };
}

export async function removeDevProxyTarget(name: string): Promise<{ ok: true } | { error: string }> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(`${DEV_PROXY_TARGETS_ROUTE}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  } catch {
    return { error: UNREACHABLE };
  }
  if (response.status !== NO_CONTENT && !response.ok) return { error: await readError(response) };
  return { ok: true };
}
