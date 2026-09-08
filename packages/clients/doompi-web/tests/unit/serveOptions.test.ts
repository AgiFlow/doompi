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

  it('accepts both forms of every flag', () => {
    expect(parseServeOptions(['--dir=/workspace/inline']).directory).toBe('/workspace/inline');
    expect(parseServeOptions(['--dir', '/workspace/separate']).directory).toBe('/workspace/separate');
    expect(parseServeOptions(['--port=9999']).port).toBe(9999);
    expect(parseServeOptions(['--port', '9999']).port).toBe(9999);
    expect(parseServeOptions(['--registry-dir=/tmp/run']).registryDir).toBe('/tmp/run');
    expect(parseServeOptions(['--host=0.0.0.0']).host).toBe('0.0.0.0');
  });

  it('rejects unknown flags and bare arguments', () => {
    expect(() => parseServeOptions(['--nope'])).toThrow('Unknown option "--nope".');
    expect(() => parseServeOptions(['-x'])).toThrow('Unknown option "-x".');
    expect(() => parseServeOptions(['serve'])).toThrow('Unknown option "serve".');
    expect(() => parseServeOptions(['--port', '8123', 'extra'])).toThrow('Unknown option "extra".');
  });

  it('rejects a port that is not a port', () => {
    expect(() => parseServeOptions(['--port', 'http'])).toThrow('--port expects a port number, received "http".');
    expect(() => parseServeOptions(['--port=70000'])).toThrow('--port expects a port number, received "70000".');
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
