import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSocketHeadroom,
  DEFAULT_PORT,
  hubArguments,
  hubEntry,
  hubEnvironment,
  LOOPBACK_HOST,
} from '../../src/services/hubLaunch.ts';

describe('locating the staged cockpit', () => {
  it('reads from the resources directory once packaged', () => {
    const entry = hubEntry({ resourcesPath: '/Apps/DoomPi.app/Contents/Resources', packaged: true, projectRoot: '/x' });
    expect(entry).toBe(
      path.join('/Apps/DoomPi.app/Contents/Resources', 'runtime', 'doompi-web', 'dist', 'bin', 'serve.mjs'),
    );
  });

  it('reads from the local build directory when running unpackaged', () => {
    const entry = hubEntry({ resourcesPath: '/ignored', packaged: false, projectRoot: '/repo/pkg' });
    expect(entry.startsWith(path.join('/repo/pkg', 'build', 'runtime'))).toBe(true);
  });
});

describe('the runtime handed to the cockpit', () => {
  it('turns this binary into Node for every descendant', () => {
    expect(hubEnvironment({ PATH: '/usr/bin' }, '/runtime/doompi-web/dist/bin/serve.mjs').ELECTRON_RUN_AS_NODE).toBe(
      '1',
    );
  });

  it('keeps provider configuration but drops a parent session composition', () => {
    const environment = hubEnvironment(
      { ANTHROPIC_API_KEY: 'secret', DOOMPI_ROOT: '/parent/repository', DOOMPI_STATE: '/parent/state.json' },
      '/runtime/doompi-web/dist/bin/serve.mjs',
    );
    expect(environment.ANTHROPIC_API_KEY).toBe('secret');
    expect(environment.DOOMPI_ROOT).toBeUndefined();
    expect(environment.DOOMPI_STATE).toBeUndefined();
  });

  it('points dynamic commands and native tools at the runtime artifact', () => {
    const environment = hubEnvironment({}, '/runtime/doompi-web/dist/bin/serve.mjs');
    expect(environment.DOOMPI_SERVER_COMMAND).toBe(path.join('/runtime', 'doompi-server', 'dist', 'bin', 'serve.mjs'));
    expect(environment.DOOMPI_AGENT_COMMAND).toBe(path.join('/runtime', 'doompi', 'dist', 'bin', 'dpi.mjs'));
    expect(environment.DOOMPI_SYNC_COMMAND).toBe(path.join('/runtime', 'doompi', 'dist', 'bin', 'dpi.mjs'));
    expect(environment.DOOMPI_PACKAGE_ROOT).toBe(path.join('/runtime', 'doompi', 'dist', 'src'));
    expect(environment.DOOMPI_BOOTSTRAP_ENTRY).toBe(
      path.join('/runtime', 'doompi', 'dist', 'src', 'extensions', 'entries', 'doom.mjs'),
    );
    expect(environment.DOOMPI_PACKAGE_CATALOG).toBe(path.join('/runtime', 'catalog', 'index.json'));
    expect(environment.DOOMPI_NPM_CLI).toBe(path.join('/runtime', 'vendor', 'npm', 'bin', 'npm-cli.js'));
    expect(environment.DOOMPI_WEB_MODULE).toBe('file:///runtime/doompi-web/dist/index.mjs');
    expect(environment.DOOMPI_WEB_DIST).toBeUndefined();
    expect(environment.DOOMPI_WEB_PACKAGE_ROOT).toBe(path.join('/runtime', 'doompi-web'));
    expect(environment.DOOMPI_VITE_PACKAGE_ROOT).toBe(path.join('/runtime', 'vendor', 'vite'));
    expect(environment.DOOMPI_CLOUDFLARED).toBe(
      path.join('/runtime', 'vendor', 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    );
    expect(environment.NODE_PATH).toBe(
      [path.join('/runtime', 'node_modules'), path.join('/runtime', 'native', 'node_modules')].join(path.delimiter),
    );
    expect(environment.DOOMPI_RMUX_BINARY).toBe(
      path.join(
        '/runtime',
        'node_modules',
        '@agimon-ai',
        `doompi-runner-rmux-${process.platform}-${process.arch}`,
        'vendor',
        'bin',
        'rmux',
      ),
    );
    expect(environment.DOOMPI_RTK_BINARY).toBe(
      path.join(
        '/runtime',
        'node_modules',
        '@agimon-ai',
        `doompi-runner-rtk-${process.platform}-${process.arch}`,
        'vendor',
        'bin',
        'rtk',
      ),
    );
  });
});

describe('socket headroom', () => {
  it('accepts the default home-directory registry', () => {
    expect(() => assertSocketHeadroom('/Users/someone/.doompi/run')).not.toThrow();
  });

  it('still accepts the macOS application-support path for a short username', () => {
    // Worth pinning: this path is long but it fits, so the guard must not be
    // used to argue that userData is impossible. It is not; sharing the
    // registry with the CLI is the reason the home directory is preferred.
    expect(() => assertSocketHeadroom('/Users/someone/Library/Application Support/DoomPi/run')).not.toThrow();
  });

  it('refuses a directory that leaves no room for a session socket', () => {
    const longUser = '/Users/a-rather-long-corporate-account/Library/Application Support/DoomPi/run';
    expect(() => assertSocketHeadroom(longUser)).toThrow(/below the 40/u);
  });

  it('names the directory it rejected', () => {
    const tooLong = `/${'d'.repeat(90)}`;
    expect(() => assertSocketHeadroom(tooLong)).toThrow(new RegExp(tooLong, 'u'));
  });
});

describe('cockpit arguments', () => {
  it('pins the host, port and registry so nothing is left to a default', () => {
    expect(
      hubArguments({ entry: '/hub/serve.mjs', host: LOOPBACK_HOST, port: DEFAULT_PORT, registryDir: '/r' }),
    ).toEqual(['/hub/serve.mjs', '--host', '127.0.0.1', '--port', '7433', '--registry-dir', '/r']);
  });
});
