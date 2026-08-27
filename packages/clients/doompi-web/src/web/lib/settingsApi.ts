import {
  SETTINGS_CONFIG_API_ROUTE,
  SETTINGS_MODELS_API_ROUTE,
  SETTINGS_REPOSITORIES_API_ROUTE,
  SETTINGS_VALUE_API_ROUTE,
  type SettingsConfigView,
  type SettingsModel,
  type SettingsRepository,
  type SettingsWriteRequest,
} from '../../types/settings.ts';
import { sealedHttpSession } from './sealedSession.ts';
import { fetchWithStepUp } from './stepUp.ts';

/**
 * The page's half of the settings routes. The only place the cockpit talks
 * HTTP for configuration, so if the transport changes, it changes here alone.
 *
 * Writes go through the step-up gate for the same reason a provider credential
 * does: changing a planning model redirects where this machine's model traffic
 * goes, and a remote caller should prove itself first.
 */

const UNREACHABLE = 'The hub is unreachable.';
const JSON_HEADERS = { 'content-type': 'application/json' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type ReadConfigResult = { ok: true; config: SettingsConfigView } | { ok: false; error: string };

export async function readSettingsConfig(repoRoot: string, keys: readonly string[]): Promise<ReadConfigResult> {
  const search = new URLSearchParams({ repoRoot });
  for (const key of keys) search.append('key', key);
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(`${SETTINGS_CONFIG_API_ROUTE}?${search.toString()}`);
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (!response.ok) return { ok: false, error: errorOf(body, `The hub answered ${String(response.status)}.`) };
  if (!isRecord(body)) return { ok: false, error: 'The hub answered with no configuration.' };
  return { ok: true, config: body as unknown as SettingsConfigView };
}

export type WriteConfigResult =
  | { ok: true; config: SettingsConfigView }
  /** The file moved under the page; `hash` is what it holds now. */
  | { ok: false; stale: true; error: string; hash?: string }
  | { ok: false; stale: false; error: string };

export async function writeSettingsValue(request: SettingsWriteRequest): Promise<WriteConfigResult> {
  let response: Response;
  try {
    response = await fetchWithStepUp(SETTINGS_VALUE_API_ROUTE, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, stale: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (response.status === 409) {
    const hash = isRecord(body) && typeof body.hash === 'string' ? body.hash : undefined;
    return {
      ok: false,
      stale: true,
      error: errorOf(body, 'The config changed since it was read.'),
      ...(hash === undefined ? {} : { hash }),
    };
  }
  if (!response.ok) {
    return { ok: false, stale: false, error: errorOf(body, `The hub answered ${String(response.status)}.`) };
  }
  if (!isRecord(body)) return { ok: false, stale: false, error: 'The hub answered with no configuration.' };
  return { ok: true, config: body as unknown as SettingsConfigView };
}

/** The repositories the picker offers; an empty list is a machine with no sessions. */
export async function listSettingsRepositories(): Promise<readonly SettingsRepository[]> {
  try {
    const response = await sealedHttpSession.fetch(SETTINGS_REPOSITORIES_API_ROUTE);
    const body = await readBody(response);
    if (!response.ok || !isRecord(body) || !Array.isArray(body.repositories)) return [];
    return body.repositories as SettingsRepository[];
  } catch {
    return [];
  }
}

/**
 * The models a picker offers. An empty list is not an error: a machine with no
 * authenticated provider has none, and those fields fall back to free text.
 */
export async function listSettingsModels(): Promise<readonly SettingsModel[]> {
  try {
    const response = await sealedHttpSession.fetch(SETTINGS_MODELS_API_ROUTE);
    const body = await readBody(response);
    if (!response.ok || !isRecord(body) || !Array.isArray(body.models)) return [];
    return body.models as SettingsModel[];
  } catch {
    return [];
  }
}
