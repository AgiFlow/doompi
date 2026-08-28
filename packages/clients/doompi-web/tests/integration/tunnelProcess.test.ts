import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARED_ENV,
  createTunnelLauncher,
  findCloudflared,
  reapStaleTunnel,
} from '../../src/adapters/tunnelProcess.ts';
import { PAIRING_PAGE_MARKER } from '../../src/services/pairingPage.ts';
import type { ProbeResult } from '../../src/adapters/tunnelProcess.ts';

const PUBLIC_ORIGIN = 'https://calm-river-1234.trycloudflare.com';

/** The shape cloudflared prints a quick tunnel's URL in. */
const BANNER = `
2026-08-27T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-27T10:00:01Z INF +---------------------------------------------+
2026-08-27T10:00:01Z INF |  Your quick Tunnel has been created!        |
2026-08-27T10:00:01Z INF |  ${PUBLIC_ORIGIN}  |
2026-08-27T10:00:01Z INF +---------------------------------------------+
2026-08-27T10:00:02Z INF Registered tunnel connection connIndex=0
`;

let stateDir: string;
let binDir: string;
let notices: string[];

/** Writes an executable stand-in for cloudflared. */
function script(name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function goodProbe(url: string): Promise<ProbeResult> {
  if (url.endsWith('/pair')) return Promise.resolve({ status: 200, body: `<b>${PAIRING_PAGE_MARKER}</b>` });
  return Promise.resolve({ status: 401, body: '{"error":"This device is not paired."}' });
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-tunnel-state-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-tunnel-bin-'));
  notices = [];
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe('findCloudflared', () => {
  it('takes the first executable on PATH', () => {
    const binary = script('cloudflared', 'exit 0');
    expect(findCloudflared({ PATH: `${path.join(binDir, 'nowhere')}${path.delimiter}${binDir}` })).toBe(binary);
  });

  it('skips a file that is not executable', () => {
    fs.writeFileSync(path.join(binDir, 'cloudflared'), '#!/bin/sh\n', { mode: 0o644 });
    expect(findCloudflared({ PATH: binDir })).toBeUndefined();
  });

  it('tolerates an empty PATH entry', () => {
    expect(findCloudflared({ PATH: `${path.delimiter}${path.delimiter}` })).toBeUndefined();
  });
});

describe('starting a tunnel', () => {
  it('reports the URL it announced once the self-test passes', async () => {
    const binary = script('cloudflared', `cat <<'EOF'\n${BANNER}\nEOF\nsleep 30`);
    const events: string[] = [];
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      probe: async (url) => {
        events.push('probe');
        return await goodProbe(url);
      },
      onNotice: (message) => notices.push(message),
    });
    const result = await launch({
      port: 7999,
      config: { kind: 'quick' },
      acceptOrigin: (origin) => events.push(`accept ${origin}`),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicOrigin).toBe(PUBLIC_ORIGIN);
    expect(events).toEqual([`accept ${PUBLIC_ORIGIN}`, 'probe', 'probe']);
    expect(fs.existsSync(path.join(stateDir, 'tunnel.pid'))).toBe(true);
    await result.stop();
    expect(fs.existsSync(path.join(stateDir, 'tunnel.pid'))).toBe(false);
  });

  it('retries while a new public hostname is still propagating', async () => {
    const binary = script('cloudflared', `cat <<'EOF'\n${BANNER}\nEOF\nsleep 30`);
    let attempts = 0;
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      selfTestRetryMs: 0,
      probe: async (url) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return await goodProbe(url);
      },
    });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    if (result.ok) await result.stop();
  });

  it('keeps the startup deadline active through an in-progress self-test', async () => {
    const binary = script('cloudflared', `cat <<'EOF'\n${BANNER}\nEOF\nsleep 30`);
    let probeAborted = false;
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      startTimeoutMs: 1000,
      probe: async (_url, signal) =>
        await new Promise<ProbeResult>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              probeAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    expect(result).toMatchObject({ ok: false, failure: 'timeout' });
    expect(probeAborted).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'tunnel.pid'))).toBe(false);
  });
  it('kills the tunnel when the guard is not armed', async () => {
    // The one failure worth aborting on rather than warning about: the agent
    // would be reachable from the public internet with no credential.
    const binary = script('cloudflared', `cat <<'EOF'\n${BANNER}\nEOF\nsleep 30`);
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      probe: async (url) =>
        url.endsWith('/pair')
          ? { status: 200, body: PAIRING_PAGE_MARKER }
          : { status: 200, body: '{"ok":true,"role":"hub"}' },
      onNotice: (message) => notices.push(message),
    });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('self_test_failed');
    expect(result.message).toContain('/api/health answered 200');
  });

  it('fails when the pairing page is not reachable through the tunnel', async () => {
    const binary = script('cloudflared', `cat <<'EOF'\n${BANNER}\nEOF\nsleep 30`);
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      probe: async (url) => (url.endsWith('/pair') ? { status: 404, body: '' } : { status: 401, body: '' }),
    });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('self_test_failed');
  });

  it('reports a binary that exits immediately, with its output', async () => {
    const binary = script('cloudflared', 'echo "failed to connect to the edge" >&2\nexit 1');
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('exited');
    expect(result.message).toContain('failed to connect to the edge');
  });

  it('says so plainly when cloudflared is not installed', async () => {
    const launch = createTunnelLauncher({ cloudflaredPath: '', stateDir, probe: goodProbe });
    const previous = process.env[CLOUDFLARED_ENV];
    delete process.env[CLOUDFLARED_ENV];
    const previousPath = process.env.PATH;
    process.env.PATH = path.join(binDir, 'empty');
    try {
      const result = await launch({ port: 7999, config: { kind: 'quick' } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toBe('not_installed');
      expect(result.message).toContain('brew install cloudflared');
    } finally {
      process.env.PATH = previousPath;
      if (previous !== undefined) process.env[CLOUDFLARED_ENV] = previous;
    }
  });

  it('does not accept a hostname that merely contains a tunnel domain', async () => {
    // A lookalike would otherwise become the origin the guard then trusts.
    const binary = script(
      'cloudflared',
      `echo "https://evil.trycloudflare.com.attacker.tld"\necho "Registered tunnel connection"\nsleep 30`,
    );
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const started = launch({ port: 7999, config: { kind: 'quick' } });
    // No URL is ever extracted, so this can only end at the deadline; assert
    // the absence rather than waiting 45 seconds for it.
    await expect(
      Promise.race([started, new Promise((resolve) => setTimeout(() => resolve('pending'), 500))]),
    ).resolves.toBe('pending');
  });

  it('skips parsing entirely for a named tunnel', async () => {
    const binary = script('cloudflared', 'echo "starting"\nsleep 30');
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({ port: 7999, config: { kind: 'named', hostname: 'doom.example.com' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicOrigin).toBe('https://doom.example.com');
    await result.stop();
  });
});

describe('reapStaleTunnel', () => {
  it('does nothing when there is no pid file', () => {
    reapStaleTunnel(stateDir, (message) => notices.push(message));
    expect(notices).toEqual([]);
  });

  it('removes a pid file it has considered', () => {
    const pidPath = path.join(stateDir, 'tunnel.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: 2 ** 30, startedAt: Date.now() }));
    reapStaleTunnel(stateDir, (message) => notices.push(message));
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('removes a stale runtime token file even without a pid file', () => {
    const runtimeTokenFile = path.join(stateDir, 'tunnel.token');
    fs.writeFileSync(runtimeTokenFile, 'secret-token');
    reapStaleTunnel(stateDir, (message) => notices.push(message));
    expect(fs.existsSync(runtimeTokenFile)).toBe(false);
  });
  it('ignores a pid recorded too long ago to trust', () => {
    // Past the window a recycled pid could belong to anything, so leaving it
    // alone beats killing an unrelated process.
    const pidPath = path.join(stateDir, 'tunnel.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, startedAt: 0 }));
    reapStaleTunnel(stateDir, (message) => notices.push(message));
    expect(notices).toEqual([]);
  });
});

describe('stopping a tunnel', () => {
  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    // Without this a wedged cloudflared would keep the tunnel open after the
    // user asked for it to close.
    const binary = script('cloudflared', `trap '' TERM\ncat <<'EOF2'\n${BANNER}\nEOF2\nsleep 30`);
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    if (!result.ok) throw new Error(result.message);
    await result.stop();
    // Resolving at all means the escalation fired; a SIGTERM alone never lands.
    expect(fs.existsSync(path.join(stateDir, 'tunnel.pid'))).toBe(false);
  });

  it('is safe to stop twice', async () => {
    const binary = script('cloudflared', `cat <<'EOF2'\n${BANNER}\nEOF2\nsleep 30`);
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    if (!result.ok) throw new Error(result.message);
    await result.stop();
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it('tells the host when cloudflared dies on its own', async () => {
    // A tunnel that died leaves a cockpit that looks reachable and is not, so
    // the host tears the listener down rather than waiting to be asked.
    const binary = script('cloudflared', `cat <<'EOF2'\n${BANNER}\nEOF2\nsleep 0.3\nexit 3`);
    const exits: string[] = [];
    const launch = createTunnelLauncher({
      cloudflaredPath: binary,
      stateDir,
      probe: goodProbe,
      onExit: (message) => exits.push(message),
    });
    const result = await launch({ port: 7999, config: { kind: 'quick' } });
    if (!result.ok) throw new Error(result.message);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(exits[0]).toContain('stopped on its own');
  });

  it('passes a protected runtime token file and removes it on stop', async () => {
    // The token is a Cloudflare account credential, so neither settings nor
    // the process argument list should contain its value.
    const tokenFile = path.join(stateDir, 'token');
    const runtimeTokenFile = path.join(stateDir, 'tunnel.token');
    fs.writeFileSync(tokenFile, '  secret-token\n');
    const binary = script('cloudflared', 'echo "$@" > "$0.args"\nsleep 30');
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({
      port: 7999,
      config: { kind: 'named', hostname: 'doom.example.com', tokenFile },
    });
    if (!result.ok) throw new Error(result.message);
    // A named tunnel is ready the moment it spawns, so give the stub a beat to
    // record what it was actually called with.
    await vi.waitFor(() => {
      expect(fs.existsSync(`${binary}.args`)).toBe(true);
    });
    const args = fs.readFileSync(`${binary}.args`, 'utf8');
    expect(args).toContain(`--token-file ${runtimeTokenFile}`);
    expect(args).not.toContain('secret-token');
    expect(fs.readFileSync(runtimeTokenFile, 'utf8')).toBe('secret-token');
    if (process.platform !== 'win32') expect(fs.statSync(runtimeTokenFile).mode & 0o777).toBe(0o600);
    await result.stop();
    expect(fs.existsSync(runtimeTokenFile)).toBe(false);
  });

  it('refuses a runtime-path token source without deleting the operator credential', async () => {
    const tokenFile = path.join(stateDir, 'tunnel.token');
    fs.writeFileSync(tokenFile, 'operator-token');
    const binary = script('cloudflared', 'echo spawned > "$0.spawned"\nsleep 30');
    const launch = createTunnelLauncher({ cloudflaredPath: binary, stateDir, probe: goodProbe });
    const result = await launch({
      port: 7999,
      config: { kind: 'named', hostname: 'doom.example.com', tokenFile },
    });
    expect(result).toMatchObject({ ok: false, failure: 'spawn_failed' });
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe('operator-token');
    expect(fs.existsSync(`${binary}.spawned`)).toBe(false);
  });
});
