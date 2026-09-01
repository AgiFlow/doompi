import { describe, expect, it } from 'vitest';
import { parseServeOptions, serveHelp } from '../../src/services/serveOptions.ts';

describe('doompi-web command options', () => {
  it('keeps the no-argument hub defaults', () => {
    expect(parseServeOptions([])).toMatchObject({
      port: 7433,
      host: '127.0.0.1',
      directory: undefined,
      help: false,
      version: false,
    });
  });

  it('accepts both forms of the pinned repository directory', () => {
    expect(parseServeOptions(['--dir=/workspace/inline']).directory).toBe('/workspace/inline');
    expect(parseServeOptions(['--dir', '/workspace/separate']).directory).toBe('/workspace/separate');
  });

  it('recognizes standard help and version flags', () => {
    expect(parseServeOptions(['--help']).help).toBe(true);
    expect(parseServeOptions(['-h']).help).toBe(true);
    expect(parseServeOptions(['--version']).version).toBe(true);
    expect(parseServeOptions(['-v']).version).toBe(true);
    expect(serveHelp()).toContain('Usage: doompi-web [options]');
    expect(serveHelp()).toContain('--dir <path>');
  });

  it('rejects an empty or missing pinned directory', () => {
    expect(() => parseServeOptions(['--dir='])).toThrow('--dir needs a value');
    expect(() => parseServeOptions(['--dir'])).toThrow('--dir needs a value');
  });

  it('preserves the existing serve overrides', () => {
    expect(
      parseServeOptions([
        '--registry-dir',
        '/tmp/run',
        '--spawn-command',
        'doompi-server',
        '--port',
        '8123',
        '--host',
        'localhost',
        '--assets',
        '/tmp/web',
        '--state-dir',
        '/tmp/state',
        '--cloudflared',
        '/usr/local/bin/cloudflared',
      ]),
    ).toMatchObject({
      registryDir: '/tmp/run',
      spawnCommand: 'doompi-server',
      port: 8123,
      host: 'localhost',
      assetsDir: '/tmp/web',
      stateDir: '/tmp/state',
      cloudflaredPath: '/usr/local/bin/cloudflared',
    });
  });
});
