import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSettingsRoutes } from '../../src/adapters/settingsRoutes.ts';
import type { SettingsConfigView, SettingsScope } from '../../src/types/settings.ts';

/**
 * The settings routes over real config files.
 *
 * What they promise is about two files: that a reader is told which one a value
 * came from, and that an edit lands in the one they chose, or is refused with
 * the reason. Writing bytes the merge then ignores is the outcome worth ruling
 * out, because it looks exactly like nothing happening.
 */

const CONFIG = '/api/settings/config';
const VALUE = '/api/settings/value';
const REPOSITORY = '/api/settings/repository';
const REPOSITORY_SELECTION = '/api/settings/repository/selection';
const MAIN_MODEL = 'modes.planning.main.model';

const temporaries: string[] = [];

function workspace(): { home: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-settings-routes-'));
  temporaries.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.pi', '.doom'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.doom'), { recursive: true });
  return { home, repo };
}

function app(home: string, repositoryPath = '/repo-one'): Hono {
  const hono = new Hono();
  registerSettingsRoutes(hono, {
    homeDirectory: home,
    repositories: () => [{ id: 'repo-one', path: repositoryPath, name: 'repo-one', active: true }],
    models: async () => [{ value: 'anthropic/opus', label: 'opus', group: 'Anthropic' }],
  });
  return hono;
}

function writeGlobal(home: string, yaml: string): void {
  fs.writeFileSync(path.join(home, '.pi', '.doom', 'config.yaml'), yaml);
}

function writeRepository(repo: string, yaml: string): void {
  fs.writeFileSync(path.join(repo, '.doom', 'config.yaml'), yaml);
}

function writeCatalogs(home: string, repo: string): void {
  fs.writeFileSync(
    path.join(home, '.pi', '.doom', 'modes.yaml'),
    [
      'defaultMajorMode: copilot',
      'layers: {}',
      'majorMode:',
      '  copilot:',
      '    description: General-purpose mode.',
      '    layers: []',
      '  minimal:',
      '    description: Minimal mode.',
      '    layers: []',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(home, '.pi', '.doom', 'domains.yaml'),
    [
      'defaultDomains: [development]',
      'plugins: { roots: [], entries: {} }',
      'domains:',
      '  development: { description: Build product code., plugins: [] }',
      '  testing: { description: Verify behavior., plugins: [] }',
      'aliases:',
      '  quality: [development, testing]',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(repo, 'agents', 'reviewer'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'agents', 'reviewer', 'AGENTS.md'), 'Review carefully.\n');
  fs.writeFileSync(
    path.join(repo, '.doom', 'profiles.yaml'),
    'profiles:\n  entries:\n    reviewer:\n      persona: agents/reviewer\n',
  );
}

async function read(hono: Hono, repo: string, key = MAIN_MODEL): Promise<SettingsConfigView> {
  const search = new URLSearchParams(repo === '' ? {} : { repoRoot: repo });
  search.append('key', key);
  const response = await hono.request(`${CONFIG}?${search.toString()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SettingsConfigView;
}

async function save(hono: Hono, body: unknown): Promise<Response> {
  return await hono.request(VALUE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function writeBody(repo: string, scope: SettingsScope, hash: string, value: string | null, key = MAIN_MODEL): unknown {
  return { repoRoot: repo, scope, keyPath: key.split('.'), value, expectedHash: hash };
}

afterEach(() => {
  while (temporaries.length > 0) fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe('reading configuration', () => {
  it('answers a value with where it came from and which scopes may hold it', async () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/from-global\n');

    const config = await read(app(home), repo);

    expect(config.values[MAIN_MODEL]).toEqual({
      value: 'anthropic/from-global',
      origin: 'global',
      scope: 'both',
    });
  });

  it('names the repository when it overrides', async () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/from-global\n');
    writeRepository(repo, 'modes:\n  planning:\n    main:\n      model: anthropic/from-repo\n');

    const config = await read(app(home), repo);

    expect(config.values[MAIN_MODEL]).toMatchObject({ value: 'anthropic/from-repo', origin: 'repository' });
  });

  it('reports a key no file set as a default with no value', async () => {
    const { home, repo } = workspace();

    const config = await read(app(home), repo);

    expect(config.values[MAIN_MODEL]).toEqual({ origin: 'default', scope: 'both' });
  });

  it('answers the global half when no repository is in view', async () => {
    // The settings page opens with no session running, so demanding a
    // repository would leave it with nothing to render at all rather than
    // with the global settings, which stand on their own.
    const { home } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/from-global\n');

    const response = await app(home).request(`${CONFIG}?key=${MAIN_MODEL}`);

    expect(response.status).toBe(200);
    const config = (await response.json()) as SettingsConfigView;
    expect(config.repoRoot).toBe('');
    expect(config.values[MAIN_MODEL]).toMatchObject({ value: 'anthropic/from-global', origin: 'global' });
    expect(config.hashes.repository).toBe('');
  });

  it('reports a malformed file rather than answering a blank page', async () => {
    // This page is where someone goes to repair a broken config, so it has to
    // say what is wrong instead of rendering nothing.
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    nonsense: true\n');

    const response = await app(home).request(`${CONFIG}?repoRoot=${encodeURIComponent(repo)}&key=${MAIN_MODEL}`);

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain('unsupported');
  });
});

describe('writing configuration', () => {
  it('writes the global file and answers the key as it now stands', async () => {
    const { home, repo } = workspace();
    const hono = app(home);
    const before = await read(hono, repo);

    const response = await save(hono, writeBody(repo, 'global', before.hashes.global, 'anthropic/opus'));

    expect(response.status).toBe(200);
    expect(((await response.json()) as SettingsConfigView).values[MAIN_MODEL]).toMatchObject({
      value: 'anthropic/opus',
      origin: 'global',
    });
  });

  it('writes the repository file without touching the global one', async () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/from-global\n');
    const hono = app(home);
    const before = await read(hono, repo);

    await save(hono, writeBody(repo, 'repository', before.hashes.repository, 'anthropic/from-repo'));

    expect(fs.readFileSync(path.join(home, '.pi', '.doom', 'config.yaml'), 'utf8')).toContain('from-global');
    expect((await read(hono, repo)).values[MAIN_MODEL]).toMatchObject({
      value: 'anthropic/from-repo',
      origin: 'repository',
    });
  });

  it('clears an override and falls back to what the other file holds', async () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/from-global\n');
    writeRepository(repo, 'modes:\n  planning:\n    main:\n      model: anthropic/from-repo\n');
    const hono = app(home);
    const before = await read(hono, repo);

    await save(hono, writeBody(repo, 'repository', before.hashes.repository, null));

    expect((await read(hono, repo)).values[MAIN_MODEL]).toMatchObject({
      value: 'anthropic/from-global',
      origin: 'global',
    });
  });

  it('refuses a key the chosen file is never read from', async () => {
    // The merge takes `editor` from the global file whatever a repository says.
    // Writing it here would put bytes on disk that nothing ever reads.
    const { home, repo } = workspace();
    const hono = app(home);
    const before = await read(hono, repo, 'editor.command');

    const response = await save(hono, writeBody(repo, 'repository', before.hashes.repository, 'vi', 'editor.command'));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('only read from the global config');
    expect(fs.existsSync(path.join(repo, '.doom', 'config.yaml'))).toBe(false);
  });

  it('refuses a repository-only key at global scope', async () => {
    const { home, repo } = workspace();
    const hono = app(home);
    const before = await read(hono, repo, 'projectTrust');

    const response = await save(hono, writeBody(repo, 'global', before.hashes.global, 'always', 'projectTrust'));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("only read from this repository's config");
  });

  it('refuses a write made against bytes the file no longer holds', async () => {
    const { home, repo } = workspace();
    const hono = app(home);
    const before = await read(hono, repo);
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: anthropic/someone-else\n');

    const response = await save(hono, writeBody(repo, 'global', before.hashes.global, 'anthropic/mine'));

    expect(response.status).toBe(409);
    expect(fs.readFileSync(path.join(home, '.pi', '.doom', 'config.yaml'), 'utf8')).toContain('someone-else');
  });

  it('reports a value the parser rejects, having written nothing', async () => {
    // The writer validates the whole serialized file before publishing it, so a
    // refused value never reaches disk. `thinking` is a closed set; the model
    // is a free string the parser does not police.
    const { home, repo } = workspace();
    const hono = app(home);
    const key = 'modes.planning.main.thinking';
    const before = await read(hono, repo, key);

    const response = await save(hono, writeBody(repo, 'global', before.hashes.global, 'ludicrous', key));

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain('thinking');
    expect((await read(hono, repo, key)).values[key].origin).toBe('default');
  });

  it('writes global with no repository named', async () => {
    const { home } = workspace();
    const hono = app(home);
    const before = await read(hono, '');

    const response = await save(hono, writeBody('', 'global', before.hashes.global, 'anthropic/opus'));

    expect(response.status).toBe(200);
    expect((await read(hono, '')).values[MAIN_MODEL]).toMatchObject({
      value: 'anthropic/opus',
      origin: 'global',
    });
  });

  it('refuses a repository write with no repository named', async () => {
    const { home } = workspace();
    const hono = app(home);

    expect((await save(hono, writeBody('', 'repository', '', 'anthropic/opus'))).status).toBe(400);
  });

  it('refuses a body that is not a save', async () => {
    const { home } = workspace();
    const hono = app(home);

    expect((await hono.request(VALUE, { method: 'PUT', body: 'nope' })).status).toBe(400);
    expect((await save(hono, { repoRoot: '/x', scope: 'elsewhere', keyPath: ['a'], value: null })).status).toBe(400);
    expect((await save(hono, { repoRoot: '/x', scope: 'global', keyPath: [], value: null })).status).toBe(400);
  });
});

describe('repository selection control plane', () => {
  it('reads effective catalogs and catalog defaults through an admitted repository id', async () => {
    const { home, repo } = workspace();
    writeCatalogs(home, repo);

    const response = await app(home, repo).request(`${REPOSITORY}?repository=repo-one`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.repository).toMatchObject({ id: 'repo-one', path: repo });
    expect(body.catalogs.majorModes.map((entry: { name: string }) => entry.name)).toEqual(['copilot', 'minimal']);
    expect(body.catalogs.domains.map((entry: { name: string }) => entry.name)).toEqual([
      'development',
      'quality',
      'testing',
    ]);
    expect(body.catalogs.profiles).toEqual([{ name: 'reviewer' }]);
    expect(body.selection).toMatchObject({
      majorMode: { effective: 'copilot', origin: 'default' },
      domains: { effective: ['development'], origin: 'default' },
      profile: { origin: 'default' },
    });
  });

  it('writes all changed axes atomically and reports the repository overrides', async () => {
    const { home, repo } = workspace();
    writeCatalogs(home, repo);
    const hono = app(home, repo);
    const before = (await (await hono.request(`${REPOSITORY}?repository=repo-one`)).json()) as { hash: string };

    const response = await hono.request(REPOSITORY_SELECTION, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo-one',
        expectedHash: before.hash,
        changes: { majorMode: 'minimal', domains: ['testing'], profile: 'reviewer' },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.selection).toMatchObject({
      majorMode: { effective: 'minimal', repository: 'minimal', origin: 'repository' },
      domains: { effective: ['testing'], repository: ['testing'], origin: 'repository' },
      profile: { effective: 'reviewer', repository: 'reviewer', origin: 'repository' },
    });
    const written = fs.readFileSync(path.join(repo, '.doom', 'config.yaml'), 'utf8');
    expect(written).toContain('majorMode: minimal');
    expect(written).toContain('- testing');
    expect(written).toContain('profile: reviewer');
  });

  it('refuses unknown catalog entries, unadmitted ids, and stale hashes without writing', async () => {
    const { home, repo } = workspace();
    writeCatalogs(home, repo);
    const hono = app(home, repo);

    const unknown = await hono.request(REPOSITORY_SELECTION, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId: 'repo-one', expectedHash: '', changes: { domains: ['missing'] } }),
    });
    expect(unknown.status).toBe(422);
    expect(fs.existsSync(path.join(repo, '.doom', 'config.yaml'))).toBe(false);

    expect((await hono.request(`${REPOSITORY}?repository=not-admitted`)).status).toBe(404);
    writeRepository(repo, 'selection:\n  majorMode: copilot\n');
    const stale = await hono.request(REPOSITORY_SELECTION, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId: 'repo-one', expectedHash: '', changes: { majorMode: 'minimal' } }),
    });
    expect(stale.status).toBe(409);
    expect(fs.readFileSync(path.join(repo, '.doom', 'config.yaml'), 'utf8')).toContain('majorMode: copilot');
  });
});
describe('what the page needs besides values', () => {
  it('offers the repositories the hub knows about', async () => {
    const { home } = workspace();

    const response = await app(home).request('/api/settings/repositories');

    expect(await response.json()).toEqual({
      repositories: [{ id: 'repo-one', path: '/repo-one', name: 'repo-one', active: true }],
    });
  });

  it('offers the machine models, so a picker works with no session running', async () => {
    const { home } = workspace();

    const response = await app(home).request('/api/settings/models');

    expect(await response.json()).toEqual({
      models: [{ value: 'anthropic/opus', label: 'opus', group: 'Anthropic' }],
    });
  });
});

describe('image limits', () => {
  const IMAGES = '/api/settings/images';

  function piSettings(home: string): string {
    return path.join(home, '.pi', 'agent', 'settings.json');
  }

  async function writeImages(hono: Hono, body: unknown): Promise<Response> {
    return await hono.request(IMAGES, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers Pi is defaults on a machine that never set them', async () => {
    const { home } = workspace();

    const response = await app(home).request(IMAGES);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      autoResize: true,
      maxDimension: 2000,
      minDimension: 256,
      maxAllowedDimension: 2000,
    });
  });

  it('writes the toggle and the cap into Pi is own settings file', async () => {
    const { home } = workspace();
    const hono = app(home);

    const written = await writeImages(hono, { autoResize: false, maxDimension: 1024 });

    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ autoResize: false, maxDimension: 1024 });
    expect(JSON.parse(fs.readFileSync(piSettings(home), 'utf8'))).toEqual({
      images: { autoResize: false, maxDimension: 1024 },
    });
    expect(await (await hono.request(IMAGES)).json()).toMatchObject({ autoResize: false, maxDimension: 1024 });
  });

  it('clamps a cap Pi would undo rather than refusing the write', async () => {
    const { home } = workspace();

    const written = await writeImages(app(home), { maxDimension: 9000 });

    expect(await written.json()).toMatchObject({ maxDimension: 2000 });
  });

  it('refuses a body that is not the shape of a limit', async () => {
    const { home } = workspace();
    const hono = app(home);

    expect((await writeImages(hono, { autoResize: 'yes' })).status).toBe(400);
    expect((await writeImages(hono, { maxDimension: 'big' })).status).toBe(400);
    expect((await writeImages(hono, 'not a record')).status).toBe(400);
  });
});
