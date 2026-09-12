import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADLESS_PORT,
  DEFAULT_PORT,
  headlessArguments,
  headlessEntry,
  hubArguments,
  hubEntry,
  hubEnvironment,
  LOOPBACK_HOST,
} from '../../src/services/hubLaunch';

describe('locating the staged runtime', () => {
  it('reads the presentation entry from the resources directory once packaged', () => {
    const entry = hubEntry({ resourcesPath: '/Apps/DoomPi.app/Contents/Resources', packaged: true, projectRoot: '/x' });
    expect(entry).toBe(
      path.join('/Apps/DoomPi.app/Contents/Resources', 'runtime', 'doompi-web', 'dist', 'bin', 'serve.mjs'),
    );
  });

  it('reads the headless entry from the resources directory once packaged', () => {
    const entry = headlessEntry({
      resourcesPath: '/Apps/DoomPi.app/Contents/Resources',
      packaged: true,
      projectRoot: '/x',
    });
    expect(entry).toBe(
      path.join('/Apps/DoomPi.app/Contents/Resources', 'runtime', 'doompi', 'dist', 'bin', 'serve.mjs'),
    );
  });

  it('reads from the local build directory when running unpackaged', () => {
    const entry = hubEntry({ resourcesPath: '/ignored', packaged: false, projectRoot: '/repo/pkg' });
    expect(entry.startsWith(path.join('/repo/pkg', 'build', 'runtime'))).toBe(true);
  });
});

describe('the runtime handed to child processes', () => {
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
    expect(environment.DOOMPI_SERVER_COMMAND).toBe(path.join('/runtime', 'doompi', 'dist', 'bin', 'serve.mjs'));
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

describe('canonical child arguments', () => {
  it('starts the client-neutral server with a token file and protocol port', () => {
    expect(
      headlessArguments({
        headlessEntry: '/server/serve.mjs',
        headlessPort: DEFAULT_HEADLESS_PORT,
        tokenFile: '/tmp/t',
      }),
    ).toEqual(['/server/serve.mjs', '--auth-token-file', '/tmp/t', '--name', 'DoomPi Desktop', '--web', '7434']);
  });

  it('starts the presentation proxy against the headless endpoint', () => {
    expect(
      hubArguments({
        entry: '/web/serve.mjs',
        host: LOOPBACK_HOST,
        port: DEFAULT_PORT,
        headlessPort: DEFAULT_HEADLESS_PORT,
        token: 'secret',
      }),
    ).toEqual([
      '/web/serve.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '7433',
      '--headless-url',
      'http://127.0.0.1:7434',
      '--headless-token',
      'secret',
    ]);
  });
});
