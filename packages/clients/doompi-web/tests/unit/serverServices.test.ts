import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseServeOptions } from '../../src/services/serveOptions.ts';
import { contentTypeFor, resolveAssetPath } from '../../src/services/staticAssets.ts';

describe('parseServeOptions', () => {
  it('defaults to a loopback presentation server and the local headless endpoint', () => {
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

  it('reads presentation and headless endpoint overrides', () => {
    expect(
      parseServeOptions([
        '--port',
        '9000',
        '--host',
        '0.0.0.0',
        '--assets',
        '/srv/web',
        '--headless-url',
        'http://127.0.0.1:7440',
        '--headless-token',
        'secret',
      ]),
    ).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      assetsDir: '/srv/web',
      headlessUrl: 'http://127.0.0.1:7440',
      headlessToken: 'secret',
    });
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => parseServeOptions(['--port', 'http'])).toThrow(/expects a port number/);
    expect(() => parseServeOptions(['--port', '70000'])).toThrow(/expects a port number/);
    expect(() => parseServeOptions(['--headless-url', '--port'])).toThrow(/needs a value/);
    expect(() => parseServeOptions(['--nonsense'])).toThrow(/Unknown option/);
  });
});

describe('static assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-assets-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('maps a request onto a file inside the root', () => {
    expect(resolveAssetPath(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'));
  });

  it('keeps a traversal attempt inside the root', () => {
    // Normalising at the posix root is what neutralises the escape: the result
    // is a path that simply does not exist, never one outside the bundle.
    for (const attempt of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../../etc/passwd']) {
      const resolved = resolveAssetPath(root, attempt);
      expect(resolved).toBeDefined();
      expect(resolved?.startsWith(`${root}${path.sep}`)).toBe(true);
    }
  });

  it('refuses input it cannot safely interpret', () => {
    expect(resolveAssetPath(root, '/%ZZ')).toBeUndefined();
    expect(resolveAssetPath(root, '/a\0b')).toBeUndefined();
  });

  it('labels the types a bundle actually ships', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/x/app.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/x/font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('/x/runtime.wasm')).toBe('application/wasm');
    expect(contentTypeFor('/x/thing.bin')).toBe('application/octet-stream');
  });
});
