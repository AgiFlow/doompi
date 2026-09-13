import { describe, expect, it } from 'vitest';

import { parseServeOptions, serveHelp } from '../../src/services/serveOptions';

describe('doompi-web command options', () => {
  it('keeps the no-argument presentation defaults', () => {
    expect(parseServeOptions([])).toEqual({
      port: 7433,
      host: '127.0.0.1',
      assetsDir: undefined,
      headlessUrl: undefined,
      headlessToken: undefined,
      help: false,
      version: false,
    });
  });

  it('accepts the presentation and headless overrides', () => {
    expect(
      parseServeOptions([
        '--port=9999',
        '--host',
        '0.0.0.0',
        '--assets=/tmp/web',
        '--headless-url',
        'http://127.0.0.1:9000',
        '--headless-token=secret',
      ]),
    ).toEqual({
      port: 9999,
      host: '0.0.0.0',
      assetsDir: '/tmp/web',
      headlessUrl: 'http://127.0.0.1:9000',
      headlessToken: 'secret',
      help: false,
      version: false,
    });
  });

  it('rejects unknown flags and bare arguments', () => {
    expect(() => parseServeOptions(['--nope'])).toThrow('Unknown option "--nope".');
    expect(() => parseServeOptions(['-x'])).toThrow('Unknown option "-x".');
    expect(() => parseServeOptions(['serve'])).toThrow('Unknown option "serve".');
    expect(() => parseServeOptions(['--port', '8123', 'extra'])).toThrow('Unknown option "extra".');
  });

  it('rejects an invalid port and missing values', () => {
    expect(() => parseServeOptions(['--port', 'http'])).toThrow('--port expects a port number, received "http".');
    expect(() => parseServeOptions(['--port=70000'])).toThrow('--port expects a port number, received "70000".');
    expect(() => parseServeOptions(['--headless-url'])).toThrow('--headless-url needs a value');
  });

  it.each(['--host=', '--assets=', '--headless-token=', '--host=--port'])(
    'rejects empty or option-shaped values: %s',
    (flag) => {
      expect(() => parseServeOptions([flag])).toThrow('needs a value');
    },
  );

  it('accepts ephemeral ports and option terminators', () => {
    expect(parseServeOptions(['--port=0', '--']).port).toBe(0);
    expect(() => parseServeOptions(['--port=-1'])).toThrow('expects a port number');
  });

  it('recognizes standard help and version flags', () => {
    expect(parseServeOptions(['--help']).help).toBe(true);
    expect(parseServeOptions(['-h']).help).toBe(true);
    expect(parseServeOptions(['--version']).version).toBe(true);
    expect(parseServeOptions(['-v']).version).toBe(true);
    expect(serveHelp()).toContain('Usage: doompi-web [options]');
    expect(serveHelp()).toContain('--headless-url <url>');
  });
});
