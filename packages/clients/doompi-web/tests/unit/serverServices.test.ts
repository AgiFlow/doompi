import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { reattachDelayMs } from '../../src/services/retryPolicy.ts';
import { isLoopbackHost, parseServeOptions } from '../../src/services/serveOptions.ts';
import { createFrameDecoder, encodeFrame } from '../../src/services/sessionFraming.ts';
import { contentTypeFor, resolveAssetPath } from '../../src/services/staticAssets.ts';

describe('isLoopbackHost', () => {
  it('recognises every spelling that keeps the cockpit off the network', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LocalHost', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('treats a public bind as what it is, so the launcher can say so out loud', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('parseServeOptions', () => {
  it('needs no arguments at all: bare doompi-web is a loopback hub', () => {
    expect(parseServeOptions([])).toEqual({
      registryDir: undefined,
      spawnCommand: undefined,
      port: 7433,
      host: '127.0.0.1',
      assetsDir: undefined,
      stateDir: undefined,
      cloudflaredPath: undefined,
    });
  });

  it('reads the overrides it offers', () => {
    expect(parseServeOptions(['--registry-dir', '/custom/run']).registryDir).toBe('/custom/run');
    expect(parseServeOptions(['--spawn-command', '/opt/fake-server']).spawnCommand).toBe('/opt/fake-server');
    expect(parseServeOptions(['--port', '9000', '--host', '0.0.0.0', '--assets', '/srv/web'])).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      assetsDir: '/srv/web',
    });
  });

  it('rejects malformed input rather than guessing', () => {
    expect(() => parseServeOptions(['--port', 'http'])).toThrow(/expects a port number/);
    expect(() => parseServeOptions(['--port', '70000'])).toThrow(/expects a port number/);
    expect(() => parseServeOptions(['--registry-dir', '--port'])).toThrow(/needs a value/);
    expect(() => parseServeOptions(['--nonsense'])).toThrow(/Unknown option/);
  });

  it('takes an override for the remote-access state directory and the tunnel binary', () => {
    expect(parseServeOptions(['--state-dir', '/srv/state', '--cloudflared', '/opt/cloudflared'])).toMatchObject({
      stateDir: '/srv/state',
      cloudflaredPath: '/opt/cloudflared',
    });
  });

  it('no longer accepts the withdrawn single-session flags', () => {
    expect(() => parseServeOptions(['--socket', '/run/s.sock'])).toThrow(/Unknown option/);
    expect(() => parseServeOptions(['--auth-token-file', '/run/token'])).toThrow(/Unknown option/);
  });
});

describe('frame codec', () => {
  it('reassembles frames split across chunks', () => {
    const decode = createFrameDecoder();
    expect(decode('{"type":"a"}\n{"ty')).toEqual([{ type: 'a' }]);
    expect(decode('pe":"b"}\n')).toEqual([{ type: 'b' }]);
  });

  it('skips blank lines and non-object frames', () => {
    const decode = createFrameDecoder();
    expect(decode('\n\n[1,2]\n"text"\n{"type":"c"}\n')).toEqual([{ type: 'c' }]);
  });

  it('round-trips through the encoder', () => {
    const decode = createFrameDecoder();
    expect(decode(encodeFrame({ type: 'prompt', message: 'hi' }))).toEqual([{ type: 'prompt', message: 'hi' }]);
  });

  it('throws on malformed JSON so the caller can refuse the stream', () => {
    const decode = createFrameDecoder();
    expect(() => decode('{oops\n')).toThrow();
  });
});

describe('reattachDelayMs', () => {
  it('starts immediately, then backs off to a ceiling', () => {
    expect(reattachDelayMs(0)).toBe(0);
    expect(reattachDelayMs(1)).toBe(150);
    expect(reattachDelayMs(2)).toBe(300);
    expect(reattachDelayMs(40)).toBe(4000);
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
