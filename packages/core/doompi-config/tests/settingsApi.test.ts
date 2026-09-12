import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';
import type { SettingsConfigView } from '../src/types/settings';
import { settingsApi } from '../src/controllers/settingsApi';

let directory: string;
let home: string;
let repo: string;
let handlers: DoomApiHandler[];
const changed = vi.fn();
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-settings-mount-'));
  home = path.join(directory, 'home');
  repo = path.join(directory, 'repo');
  fs.mkdirSync(path.join(home, '.pi', '.doom'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.doom'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.pi', '.doom', 'config.yaml'),
    'modes:\n  planning:\n    main:\n      thinking: high\n',
  );
  fs.writeFileSync(
    path.join(repo, '.doom', 'config.yaml'),
    '# keep\nmodes:\n  planning:\n    main:\n      thinking: low\n',
  );
  handlers = [];
  changed.mockClear();
});
afterEach(() => {
  for (const handler of handlers) handler.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function mount(scope: 'global' | 'workspace') {
  const context: DoomApiContext = {
    scope,
    homeDirectory: home,
    onNotice: () => {},
    configurationChanged: changed,
    ...(scope === 'workspace' ? { workspaceId: 'repo', workspaceRoot: repo, cwd: repo } : {}),
    repositories: () => [{ id: 'repo', name: 'repo', path: repo, active: false }],
  };
  const handler = settingsApi.start(context);
  handlers.push(handler);
  return {
    handler,
    request: (route: string, body?: unknown) =>
      handler.fetch(
        new Request(
          `http://mount${route}`,
          body === undefined
            ? undefined
            : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        ),
      ),
  };
}

describe('configuration mount ownership', () => {
  it('reads home independently and overlays repository values only inside its workspace', async () => {
    const global = mount('global');
    const workspace = mount('workspace');
    const route = '/config?key=modes.planning.main.thinking';
    expect(await (await global.request(route)).json()).toMatchObject({
      repoRoot: '',
      values: { 'modes.planning.main.thinking': { value: 'high', origin: 'global' } },
    });
    expect(await (await workspace.request(route)).json()).toMatchObject({
      repoRoot: repo,
      values: { 'modes.planning.main.thinking': { value: 'low', origin: 'repository' } },
    });
    expect(await (await global.request('/repositories')).json()).toMatchObject({
      repositories: [{ id: 'repo', active: false }],
    });
    expect((await global.request('/repository')).status).toBe(404);
    expect((await workspace.request('/missing')).status).toBe(404);
  });

  it('rejects cross-mount writes and serializes competing writes against their read hash', async () => {
    const workspace = mount('workspace');
    const before = (await (await workspace.request('/config')).json()) as SettingsConfigView;
    const body = {
      scope: 'repository',
      repoRoot: repo,
      keyPath: ['modes', 'planning', 'main', 'thinking'],
      value: 'medium',
      expectedHash: before.hashes.repository,
    };
    expect((await workspace.request('/value', { ...body, repoRoot: path.join(directory, 'another') })).status).toBe(
      403,
    );
    expect((await workspace.request('/value', { ...body, scope: 'global' })).status).toBe(403);
    const results = await Promise.all([
      workspace.request('/value', body),
      workspace.request('/value', { ...body, value: 'high' }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 409]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(repo, '.doom', 'config.yaml'), 'utf8')).toContain('# keep');
    const next = (await results[0].json()) as SettingsConfigView;
    expect(
      (await workspace.request('/value', { ...body, value: null, expectedHash: next.hashes.repository })).status,
    ).toBe(200);
    expect(await (await workspace.request('/config?key=modes.planning.main.thinking')).json()).toMatchObject({
      values: { 'modes.planning.main.thinking': { value: 'high', origin: 'global' } },
    });
  });

  it('owns machine images globally and reports invalid requests without writing', async () => {
    const global = mount('global');
    const workspace = mount('workspace');
    expect((await workspace.request('/images')).status).toBe(404);
    expect((await global.request('/images')).status).toBe(200);
    expect(await (await global.request('/images', { autoResize: false, maxDimension: 1200 })).json()).toMatchObject({
      autoResize: false,
      maxDimension: 1200,
    });
    expect((await global.request('/images', { autoResize: 'false' })).status).toBe(400);
    expect((await global.request('/value', {})).status).toBe(400);
    expect((await global.request('/repository/selection', {})).status).toBe(400);
    expect((await global.handler.fetch(new Request('http://mount/value', { method: 'PUT', body: '{' }))).status).toBe(
      400,
    );
    global.handler.close();
    expect((await global.request('/config')).status).toBe(503);
  });
  it('validates atomic workspace selection writes before persisting any axis', async () => {
    const workspace = mount('workspace');
    const before = (await (await workspace.request('/repository')).json()) as { hash: string };
    const request = { repositoryId: 'repo', expectedHash: before.hash, changes: { domains: [] } };
    expect((await workspace.request('/repository/selection', { ...request, repositoryId: 'another' })).status).toBe(
      404,
    );
    expect((await workspace.request('/repository/selection', { ...request, expectedHash: 'old' })).status).toBe(409);
    for (const changes of [{ majorMode: 'missing' }, { domains: ['missing'] }, { profile: 'missing' }]) {
      expect((await workspace.request('/repository/selection', { ...request, changes })).status).toBe(422);
    }
    for (const changes of [{}, { extra: true }, { majorMode: '' }, { domains: [2] }, { profile: false }]) {
      expect((await workspace.request('/repository/selection', { ...request, changes })).status).toBe(400);
    }
    expect(changed).not.toHaveBeenCalled();
    const saved = await workspace.request('/repository/selection', request);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ selection: { domains: { effective: [], origin: 'repository' } } });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
