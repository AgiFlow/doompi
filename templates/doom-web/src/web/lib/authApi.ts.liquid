import {
  AUTH_LOGINS_API_ROUTE,
  AUTH_PROVIDERS_API_ROUTE,
  type AuthMethodType,
  type LoginFlowSnapshot,
  type ProviderAuthSummary,
} from '../../types/auth.ts';
import { fetchWithStepUp } from './stepUp.ts';

export type ProvidersResult = { providers: ProviderAuthSummary[] } | { error: string };
export type LoginFlowResult = { flow: LoginFlowSnapshot } | { error: string };
export type LogoutResult = { ok: true } | { error: string };

const UNREACHABLE = 'The cockpit hub is unreachable.';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One shape for every provider-auth call: a network failure, a non-2xx
 * answer, and a 2xx body missing the expected field all come back as
 * `{ error }`, so the settings page has one branch to render.
 */
async function request<T>(
  input: string,
  init: RequestInit | undefined,
  pick: (body: Record<string, unknown>) => T | undefined,
): Promise<T | { error: string }> {
  let response: Response;
  try {
    // Writing or clearing a provider credential redirects the machine's model
    // traffic, so a remote caller answers a passkey challenge for it first.
    response = await fetchWithStepUp(input, init);
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
  const error = isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`;
  return { error };
}

const pickFlow = (body: Record<string, unknown>): { flow: LoginFlowSnapshot } | undefined =>
  isRecord(body.flow) ? { flow: body.flow as unknown as LoginFlowSnapshot } : undefined;

/** Every provider Pi knows on the hub's machine, with its auth state. */
export function listProviders(): Promise<ProvidersResult> {
  return request(AUTH_PROVIDERS_API_ROUTE, undefined, (body) =>
    Array.isArray(body.providers) ? { providers: body.providers as ProviderAuthSummary[] } : undefined,
  );
}

/** Starts a sign-in on the hub; the returned flow is then polled with readLogin. */
export function startLogin(providerId: string, type: AuthMethodType): Promise<LoginFlowResult> {
  return request(
    AUTH_LOGINS_API_ROUTE,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ providerId, type }) },
    pickFlow,
  );
}

export function readLogin(flowId: string): Promise<LoginFlowResult> {
  return request(`${AUTH_LOGINS_API_ROUTE}/${encodeURIComponent(flowId)}`, undefined, pickFlow);
}

export function answerLogin(flowId: string, promptId: string, value: string): Promise<LoginFlowResult> {
  return request(
    `${AUTH_LOGINS_API_ROUTE}/${encodeURIComponent(flowId)}/answer`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ promptId, value }) },
    pickFlow,
  );
}

export function cancelLogin(flowId: string): Promise<LoginFlowResult> {
  return request(`${AUTH_LOGINS_API_ROUTE}/${encodeURIComponent(flowId)}`, { method: 'DELETE' }, pickFlow);
}

/** Removes the credential /login stored; environment variables are untouched. */
export function logoutProvider(providerId: string): Promise<LogoutResult> {
  return request(`${AUTH_PROVIDERS_API_ROUTE}/${encodeURIComponent(providerId)}`, { method: 'DELETE' }, () => ({
    ok: true as const,
  }));
}
