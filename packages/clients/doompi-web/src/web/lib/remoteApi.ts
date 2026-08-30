import { REMOTE_API_ROUTE, type RemoteAccessSettings, type RemoteAccessStateView } from '../../types/remoteAccess.ts';
import { sealedHttpSession } from './sealedSession.ts';

export type StateResult = { state: RemoteAccessStateView } | { error: string };
/** Enabling a contained cockpit moves the hub, so the answer says the address is about to change. */
export type EnableResult = { state: RemoteAccessStateView; handingOver?: boolean } | { error: string };
export type PairingResult =
  | { code: string; manualCode: string; pairUrl: string; expiresAt: string }
  | { error: string };

const UNREACHABLE = 'The cockpit hub is unreachable.';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One shape for every remote-access call, mirroring `authApi.ts`: a network
 * failure, a non-2xx answer, and a 2xx body missing what was asked for all come
 * back as `{ error }`, so the dialog has one branch to render.
 */
async function request<T>(
  input: string,
  init: RequestInit | undefined,
  pick: (body: Record<string, unknown>) => T | undefined,
): Promise<T | { error: string }> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(input, init);
  } catch {
    return { error: UNREACHABLE };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok && isRecord(body)) {
    const picked = pick(body);
    if (picked !== undefined) return picked;
  }
  if (isRecord(body) && typeof body.error === 'string') return { error: body.error };
  return { error: `The hub answered ${String(response.status)}.` };
}

function pickState(body: Record<string, unknown>): { state: RemoteAccessStateView } | undefined {
  return isRecord(body.state) ? { state: body.state as unknown as RemoteAccessStateView } : undefined;
}

export async function fetchRemoteState(): Promise<StateResult> {
  return await request(REMOTE_API_ROUTE, undefined, pickState);
}

export async function enableRemoteAccess(): Promise<EnableResult> {
  return await request(`${REMOTE_API_ROUTE}/enable`, { method: 'POST' }, (body) => {
    const picked = pickState(body);
    if (picked === undefined) return undefined;
    return body.handingOver === true ? { ...picked, handingOver: true } : picked;
  });
}

export async function disableRemoteAccess(): Promise<StateResult> {
  return await request(`${REMOTE_API_ROUTE}/disable`, { method: 'POST' }, pickState);
}

/** Mints the code the QR encodes. Each call retires the previous one. */
export async function mintPairingCode(): Promise<PairingResult> {
  return await request(`${REMOTE_API_ROUTE}/codes`, { method: 'POST' }, (body) =>
    typeof body.pairUrl === 'string' &&
    typeof body.code === 'string' &&
    typeof body.manualCode === 'string' &&
    typeof body.expiresAt === 'string'
      ? { code: body.code, manualCode: body.manualCode, pairUrl: body.pairUrl, expiresAt: body.expiresAt }
      : undefined,
  );
}

export async function approvePairing(requestId: string): Promise<StateResult> {
  return await request(
    `${REMOTE_API_ROUTE}/pairing/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST' },
    pickState,
  );
}

export async function denyPairing(requestId: string): Promise<StateResult> {
  return await request(
    `${REMOTE_API_ROUTE}/pairing/${encodeURIComponent(requestId)}/deny`,
    { method: 'POST' },
    pickState,
  );
}

export async function revokeDevice(id: string): Promise<StateResult> {
  return await request(`${REMOTE_API_ROUTE}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, pickState);
}

export async function saveRemoteSettings(
  patch: Partial<RemoteAccessSettings>,
): Promise<{ settings: RemoteAccessSettings } | { error: string }> {
  return await request(
    `${REMOTE_API_ROUTE}/settings`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(patch) },
    (body) => (isRecord(body.settings) ? { settings: body.settings as unknown as RemoteAccessSettings } : undefined),
  );
}
