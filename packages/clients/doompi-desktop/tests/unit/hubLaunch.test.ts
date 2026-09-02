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
    // pnpm deploy writes the package at the root of its target, so the entry is
    // hub/dist, not hub/node_modules/@agimon-ai/doompi-web/dist.
    expect(entry).toBe(
      path.join('/Apps/DoomPi.app/Contents/Resources', 'app.asar.unpacked', 'build', 'hub', 'dist', 'bin', 'serve.mjs'),
    );
  });

  it('reads from the local build directory when running unpackaged', () => {
    const entry = hubEntry({ resourcesPath: '/ignored', packaged: false, projectRoot: '/repo/pkg' });
    expect(entry.startsWith(path.join('/repo/pkg', 'build', 'hub'))).toBe(true);
  });
});

describe('the runtime handed to the cockpit', () => {
  it('turns this binary into Node for every descendant', () => {
    expect(hubEnvironment({ PATH: '/usr/bin' }).ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('keeps the inherited environment, which is how the agent is configured', () => {
    expect(hubEnvironment({ ANTHROPIC_API_KEY: 'secret' }).ANTHROPIC_API_KEY).toBe('secret');
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
