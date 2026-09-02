import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { defaultServerLaunch, repositoryDoomPiCli } from '../../src/adapters/bundledServer.js';

const repositoryCliSegments = ['node_modules', '@agimon-ai', 'doompi', 'dist', 'bin', 'cli.mjs'];

describe('default Server command', () => {
  it('finds a repository-local DoomPi CLI from a nested working directory', () => {
    const expected = path.join('/workspace/project', ...repositoryCliSegments);

    expect(repositoryDoomPiCli('/workspace/project/packages/app', (candidate) => candidate === expected)).toBe(
      expected,
    );
  });

  it('launches the Server from this installation, not from PATH', () => {
    const launch = defaultServerLaunch('/workspace/project', {}, import.meta.url, () => false);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/doompi-server[/\\]dist[/\\]bin[/\\]serve\.mjs$/);
  });

  it('preserves an explicitly configured agent command', () => {
    const launch = defaultServerLaunch(
      '/workspace/project',
      { DOOMPI_AGENT_COMMAND: '/custom/doompi', DOOMPI_WEB_MODULE: 'file:///custom/web.mjs' },
      import.meta.url,
      () => false,
    );

    expect(launch.environment.DOOMPI_AGENT_COMMAND).toBe('/custom/doompi');
    expect(launch.environment.DOOMPI_WEB_MODULE).toBe('file:///custom/web.mjs');
  });

  it('launches a desktop artifact without resolving an installed package tree', () => {
    const launch = defaultServerLaunch(
      '/workspace/project',
      {
        DOOMPI_SERVER_COMMAND: '/artifact/doompi-server/dist/bin/serve.mjs',
        DOOMPI_AGENT_COMMAND: '/artifact/doompi/dist/bin/cli.mjs',
        DOOMPI_WEB_MODULE: 'file:///artifact/doompi-web/dist/index.mjs',
      },
      'file:///missing/desktop-entry.mjs',
      () => false,
    );

    expect(launch.args).toEqual(['/artifact/doompi-server/dist/bin/serve.mjs']);
    expect(launch.environment.DOOMPI_AGENT_COMMAND).toBe('/artifact/doompi/dist/bin/cli.mjs');
    expect(launch.environment.DOOMPI_WEB_MODULE).toBe('file:///artifact/doompi-web/dist/index.mjs');
  });
  it('lets Server use the repository-local agent when one exists', () => {
    const localCli = path.join('/workspace/project', ...repositoryCliSegments);
    const launch = defaultServerLaunch(
      '/workspace/project/packages/app',
      {},
      import.meta.url,
      (candidate) => candidate === localCli,
    );

    expect(launch.environment.DOOMPI_AGENT_COMMAND).toBeUndefined();
  });

  it('falls back to the DoomPi agent and Web module bundled with Web', () => {
    const launch = defaultServerLaunch('/outside/repository', {}, import.meta.url, () => false);

    expect(launch.environment.DOOMPI_AGENT_COMMAND).toMatch(/doompi[/\\]dist[/\\]bin[/\\]cli\.mjs$/);
    expect(launch.environment.DOOMPI_WEB_MODULE).toMatch(/^file:.*doompi-web[/\\]dist[/\\]index\.mjs$/);
  });
});
