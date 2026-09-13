import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listSettingsModels,
  listSettingsRepositories,
  readImageSettings,
  readRepositorySettings,
  readSettingsConfig,
  writeImageSettings,
  writeRepositorySelection,
  writeSettingsValue,
} from '../../src/web/lib/settingsApi.ts';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function text(status: number, body: string): Response {
  return new Response(body, { status });
}

const config = { repoRoot: '/repo', values: {}, hashes: { global: 'g', repository: 'r' } };
const repositorySettings = {
  repository: { id: 'repo', root: '/repo', label: 'repo' },
  hash: 'hash',
  catalogs: { majorModes: [], domains: [], profiles: [] },
  selection: {
    majorMode: { origin: 'default' },
    domains: { origin: 'default' },
    profile: { origin: 'default' },
  },
};

function stubFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings API', () => {
  it('reads selected config keys and accepts a configuration object', async () => {
    const fetchMock = stubFetch(json(200, config));

    await expect(readSettingsConfig('/repo with space', ['modes.main.model', 'voice.language'])).resolves.toEqual({
      ok: true,
      config,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/config?repoRoot=%2Frepo+with+space&key=modes.main.model&key=voice.language',
      undefined,
    );
  });

  it('reports every config read failure shape', async () => {
    stubFetch(
      json(400, { error: 'bad key' }),
      json(503, { error: '' }),
      text(200, ''),
      text(200, 'not json'),
      new Error('offline'),
    );

    await expect(readSettingsConfig('/repo', [])).resolves.toEqual({ ok: false, error: 'bad key' });
    await expect(readSettingsConfig('/repo', [])).resolves.toEqual({ ok: false, error: 'The hub answered 503.' });
    await expect(readSettingsConfig('/repo', [])).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no configuration.',
    });
    await expect(readSettingsConfig('/repo', [])).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no configuration.',
    });
    await expect(readSettingsConfig('/repo', [])).resolves.toEqual({ ok: false, error: 'The hub is unreachable.' });
  });

  it('writes values and distinguishes stale, rejected, malformed, and unreachable responses', async () => {
    const request = {
      repoRoot: '/repo',
      scope: 'global' as const,
      keyPath: ['voice', 'language'],
      value: 'en',
      expectedHash: 'old',
    };
    stubFetch(
      json(200, config),
      json(409, { error: 'changed', hash: 'new' }),
      json(409, {}),
      json(422, { error: 'invalid' }),
      text(200, ''),
      new Error('offline'),
    );

    await expect(writeSettingsValue(request)).resolves.toEqual({ ok: true, config });
    await expect(writeSettingsValue(request)).resolves.toEqual({
      ok: false,
      stale: true,
      error: 'changed',
      hash: 'new',
    });
    await expect(writeSettingsValue(request)).resolves.toEqual({
      ok: false,
      stale: true,
      error: 'The config changed since it was read.',
    });
    await expect(writeSettingsValue(request)).resolves.toEqual({ ok: false, stale: false, error: 'invalid' });
    await expect(writeSettingsValue(request)).resolves.toEqual({
      ok: false,
      stale: false,
      error: 'The hub answered with no configuration.',
    });
    await expect(writeSettingsValue(request)).resolves.toEqual({
      ok: false,
      stale: false,
      error: 'The hub is unreachable.',
    });
  });

  it('lists repositories and models, falling back to empty arrays for invalid responses', async () => {
    const repositories = [{ id: 'repo', root: '/repo', label: 'repo' }];
    const models = [{ value: 'provider/model', label: 'Model', group: 'Provider' }];
    stubFetch(
      json(200, { repositories }),
      json(500, { repositories }),
      json(200, []),
      json(200, {}),
      new Error('offline'),
      json(200, { models }),
      json(500, { models }),
      json(200, []),
      json(200, {}),
      new Error('offline'),
    );

    await expect(listSettingsRepositories()).resolves.toEqual(repositories);
    await expect(listSettingsRepositories()).resolves.toEqual([]);
    await expect(listSettingsRepositories()).resolves.toEqual([]);
    await expect(listSettingsRepositories()).resolves.toEqual([]);
    await expect(listSettingsRepositories()).resolves.toEqual([]);
    await expect(listSettingsModels()).resolves.toEqual(models);
    await expect(listSettingsModels()).resolves.toEqual([]);
    await expect(listSettingsModels()).resolves.toEqual([]);
    await expect(listSettingsModels()).resolves.toEqual([]);
    await expect(listSettingsModels()).resolves.toEqual([]);
  });

  it('reads repository settings and reports rejected, malformed, and unreachable responses', async () => {
    const fetchMock = stubFetch(
      json(200, repositorySettings),
      json(404, { error: 'gone' }),
      text(200, ''),
      new Error('offline'),
    );

    await expect(readRepositorySettings('repo with space')).resolves.toEqual({
      ok: true,
      settings: repositorySettings,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/repository?repository=repo+with+space', undefined);
    await expect(readRepositorySettings('repo')).resolves.toEqual({ ok: false, error: 'gone' });
    await expect(readRepositorySettings('repo')).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no repository settings.',
    });
    await expect(readRepositorySettings('repo')).resolves.toEqual({ ok: false, error: 'The hub is unreachable.' });
  });

  it('writes repository selection across success and failure responses', async () => {
    const request = { repositoryId: 'repo', expectedHash: 'old', changes: { majorMode: 'copilot' } };
    stubFetch(json(200, repositorySettings), json(409, {}), text(200, ''), new Error('offline'));

    await expect(writeRepositorySelection(request)).resolves.toEqual({ ok: true, settings: repositorySettings });
    await expect(writeRepositorySelection(request)).resolves.toEqual({ ok: false, error: 'The hub answered 409.' });
    await expect(writeRepositorySelection(request)).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no repository settings.',
    });
    await expect(writeRepositorySelection(request)).resolves.toEqual({ ok: false, error: 'The hub is unreachable.' });
  });

  it('reads and writes image settings across success and failure responses', async () => {
    const images = { autoResize: true, maxDimension: 1600, minDimension: 256, maxAllowedDimension: 4096 };
    stubFetch(
      json(200, images),
      json(503, { error: 'later' }),
      text(200, ''),
      new Error('offline'),
      json(200, images),
      json(422, {}),
      text(200, ''),
      new Error('offline'),
    );

    await expect(readImageSettings()).resolves.toEqual({ ok: true, images });
    await expect(readImageSettings()).resolves.toEqual({ ok: false, error: 'later' });
    await expect(readImageSettings()).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no image settings.',
    });
    await expect(readImageSettings()).resolves.toEqual({ ok: false, error: 'The hub is unreachable.' });
    await expect(writeImageSettings({ autoResize: false })).resolves.toEqual({ ok: true, images });
    await expect(writeImageSettings({ maxDimension: 2000 })).resolves.toEqual({
      ok: false,
      error: 'The hub answered 422.',
    });
    await expect(writeImageSettings({})).resolves.toEqual({
      ok: false,
      error: 'The hub answered with no image settings.',
    });
    await expect(writeImageSettings({})).resolves.toEqual({ ok: false, error: 'The hub is unreachable.' });
  });
});
