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

function app(home: string): Hono {
  const hono = new Hono();
  registerSettingsRoutes(hono, {
    homeDirectory: home,
    repositories: () => [{ path: '/repo-one', name: 'repo-one', active: true }],
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

describe('what the page needs besides values', () => {
  it('offers the repositories the hub knows about', async () => {
    const { home } = workspace();

    const response = await app(home).request('/api/settings/repositories');

    expect(await response.json()).toEqual({ repositories: [{ path: '/repo-one', name: 'repo-one', active: true }] });
  });

  it('offers the machine models, so a picker works with no session running', async () => {
    const { home } = workspace();

    const response = await app(home).request('/api/settings/models');

    expect(await response.json()).toEqual({
      models: [{ value: 'anthropic/opus', label: 'opus', group: 'Anthropic' }],
    });
  });
});
