import {
  SETTINGS_CONFIG_API_ROUTE,
  SETTINGS_IMAGES_API_ROUTE,
  SETTINGS_MODELS_API_ROUTE,
  SETTINGS_REPOSITORIES_API_ROUTE,
  SETTINGS_REPOSITORY_API_ROUTE,
  SETTINGS_REPOSITORY_SELECTION_API_ROUTE,
  SETTINGS_VALUE_API_ROUTE,
  type RepositorySelectionWriteRequest,
  type RepositorySettingsView,
  type SettingsConfigView,
  type SettingsImagesView,
  type SettingsImagesWriteRequest,
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

export type ReadRepositorySettingsResult =
  | { ok: true; settings: RepositorySettingsView }
  | { ok: false; error: string };

export async function readRepositorySettings(repositoryId: string): Promise<ReadRepositorySettingsResult> {
  const search = new URLSearchParams({ repository: repositoryId });
  try {
    const response = await sealedHttpSession.fetch(`${SETTINGS_REPOSITORY_API_ROUTE}?${search.toString()}`);
    const body = await readBody(response);
    if (!response.ok) return { ok: false, error: errorOf(body, `The hub answered ${String(response.status)}.`) };
    if (!isRecord(body)) return { ok: false, error: 'The hub answered with no repository settings.' };
    return { ok: true, settings: body as unknown as RepositorySettingsView };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export async function writeRepositorySelection(
  request: RepositorySelectionWriteRequest,
): Promise<ReadRepositorySettingsResult> {
  try {
    const response = await fetchWithStepUp(SETTINGS_REPOSITORY_SELECTION_API_ROUTE, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    const body = await readBody(response);
    if (!response.ok) return { ok: false, error: errorOf(body, `The hub answered ${String(response.status)}.`) };
    if (!isRecord(body)) return { ok: false, error: 'The hub answered with no repository settings.' };
    return { ok: true, settings: body as unknown as RepositorySettingsView };
  } catch {
    return { ok: false, error: UNREACHABLE };
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

export type ImageSettingsResult = { ok: true; images: SettingsImagesView } | { ok: false; error: string };

function imageSettingsOf(response: Response, body: unknown): ImageSettingsResult {
  if (!response.ok) return { ok: false, error: errorOf(body, `The hub answered ${String(response.status)}.`) };
  if (!isRecord(body)) return { ok: false, error: 'The hub answered with no image settings.' };
  return { ok: true, images: body as unknown as SettingsImagesView };
}

export async function readImageSettings(): Promise<ImageSettingsResult> {
  try {
    const response = await sealedHttpSession.fetch(SETTINGS_IMAGES_API_ROUTE);
    return imageSettingsOf(response, await readBody(response));
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

/**
 * Writes through the step-up gate, as every other settings write does: this
 * one decides how much of a screenshot a remote caller can push into a model.
 */
export async function writeImageSettings(request: SettingsImagesWriteRequest): Promise<ImageSettingsResult> {
  try {
    const response = await fetchWithStepUp(SETTINGS_IMAGES_API_ROUTE, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    return imageSettingsOf(response, await readBody(response));
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}
