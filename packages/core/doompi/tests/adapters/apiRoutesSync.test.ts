import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { syncApiRoutes } from '../../src/adapters/apiRoutesSync.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporary(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A package as the composition installed it: a manifest and the entry it resolved through. */
function installedPackage(manifest: Record<string, unknown>): { root: string; entry: string } {
  const root = temporary('doompi-api-pkg-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', ...manifest }));
  const entry = path.join(root, 'dist', 'extensions', 'pi.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  return { root, entry };
}

const sessionBlock = (basePath: string) => ({
  basePath,
  session: { entry: './src/exports/sessionApi.ts', dist: './dist/sessionApi.mjs' },
});

function readModule(directory: string, scope: 'session' | 'hub'): string {
  return fs.readFileSync(path.join(directory, `${scope}.routes.mjs`), 'utf8');
}

describe('generating the package API routes', () => {
  it('writes a module per scope, importing each package by absolute path', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const pkg = installedPackage({ doompiApi: sessionBlock('runner') });

    const result = syncApiRoutes({ resolvedEntries: { runner: pkg.entry }, homeDirectory });

    expect(result.mounted).toEqual({ session: ['runner'], hub: [] });
    const session = readModule(result.directory, 'session');
    expect(session).toContain(pathToFileURL(path.join(pkg.root, 'dist', 'sessionApi.mjs')).href);
    expect(session).toContain('import { api as runnerApi }');
    expect(session).toContain('export const apis = [runnerApi];');
    // The other scope still gets a module, so a host never has to special-case
    // its absence; it simply mounts nothing.
    expect(readModule(result.directory, 'hub')).toContain('export const apis = [];');
  });

  it('writes empty modules when no installed package declares an API', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const pkg = installedPackage({});

    const result = syncApiRoutes({ resolvedEntries: { plain: pkg.entry }, homeDirectory });

    expect(result.mounted).toEqual({ session: [], hub: [] });
    expect(readModule(result.directory, 'session')).toContain('export const apis = [];');
  });

  it('places a package in only the scopes it declares', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const both = installedPackage({
      doompiApi: {
        basePath: 'both',
        session: { entry: './src/a.ts', dist: './dist/a.mjs' },
        hub: { entry: './src/b.ts', dist: './dist/b.mjs' },
      },
    });

    const result = syncApiRoutes({ resolvedEntries: { both: both.entry }, homeDirectory });

    expect(result.mounted).toEqual({ session: ['both'], hub: ['both'] });
    expect(readModule(result.directory, 'session')).toContain('dist/a.mjs');
    expect(readModule(result.directory, 'hub')).toContain('dist/b.mjs');
  });

  it('reports a malformed block and leaves that package out, rather than failing the sync', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const good = installedPackage({ doompiApi: sessionBlock('good') });
    const bad = installedPackage({
      doompiApi: { basePath: 'Bad Case', session: { entry: './x.ts', dist: './x.mjs' } },
    });
    const notices: string[] = [];

    const result = syncApiRoutes({
      resolvedEntries: { good: good.entry, bad: bad.entry },
      homeDirectory,
      onNotice: (message) => notices.push(message),
    });

    expect(result.mounted.session).toEqual(['good']);
    expect(notices.join('\n')).toMatch(/basePath 'Bad Case' must be kebab-case/u);
  });

  it('lets the first package keep a contested base path', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const first = installedPackage({ doompiApi: sessionBlock('shared') });
    const second = installedPackage({ doompiApi: sessionBlock('shared') });
    const notices: string[] = [];

    const result = syncApiRoutes({
      resolvedEntries: { a: first.entry, b: second.entry },
      homeDirectory,
      onNotice: (message) => notices.push(message),
    });

    expect(result.mounted.session).toEqual(['shared']);
    expect(notices.join('\n')).toMatch(/already claims it/u);
  });

  it('replaces a previous generation rather than merging into it', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const first = installedPackage({ doompiApi: sessionBlock('gone') });
    syncApiRoutes({ resolvedEntries: { a: first.entry }, homeDirectory });

    const second = installedPackage({ doompiApi: sessionBlock('kept') });
    const result = syncApiRoutes({ resolvedEntries: { b: second.entry }, homeDirectory });

    const session = readModule(result.directory, 'session');
    expect(session).toContain('keptApi');
    expect(session).not.toContain('goneApi');
  });

  it('skips a package whose manifest cannot be read', () => {
    const homeDirectory = temporary('doompi-api-home-');
    const broken = temporary('doompi-api-broken-');
    fs.writeFileSync(path.join(broken, 'package.json'), 'not json');
    const entry = path.join(broken, 'index.mjs');
    fs.writeFileSync(entry, '');
    const notices: string[] = [];

    const result = syncApiRoutes({
      resolvedEntries: { broken: entry },
      homeDirectory,
      onNotice: (m) => notices.push(m),
    });

    expect(result.mounted.session).toEqual([]);
    expect(notices.join('\n')).toMatch(/is unreadable/u);
  });
});
