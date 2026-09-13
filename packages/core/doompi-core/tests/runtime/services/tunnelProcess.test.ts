import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAIRING_PAGE_MARKER } from '../../../src/services/pairingPage';
import {
  createTunnelLauncher,
  findCloudflared,
  reapStaleTunnel,
  type ProbeResult,
} from '../../../src/services/tunnelProcess';
import type { TunnelConfig } from '../../../src/types/remote';

const origin = 'https://demo.trycloudflare.com';
const dirs: string[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.exit(0));
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code);
  }

  ready(quick = true): void {
    if (quick) this.stderr.emit('data', Buffer.from(`https://demo.trycloudflare.com\n`));
    this.stdout.emit('data', Buffer.from('Registered tunnel connection'));
  }
}

function stateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-tunnel-test-'));
  dirs.push(dir);
  return dir;
}

function setup(config: TunnelConfig = { kind: 'quick' }) {
  const children: FakeChild[] = [];
  const spawnProcess = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => child.ready(config.kind === 'quick'));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const probe = vi.fn(async (url: string): Promise<ProbeResult> =>
    url.endsWith('/api/health') ? { status: 401, body: '' } : { status: 200, body: PAIRING_PAGE_MARKER },
  );
  const notices: string[] = [];
  const exits: string[] = [];
  const dir = stateDir();
  const launcher = createTunnelLauncher({
    cloudflaredPath: '/fake/cloudflared',
    stateDir: dir,
    spawnProcess,
    probe,
    selfTestRetryMs: 0,
    startTimeoutMs: 30,
    restartBaseDelayMs: 0,
    onNotice: (message) => notices.push(message),
    onExit: (message) => exits.push(message),
  });
  return { children, spawnProcess, probe, notices, exits, dir, launcher, config };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tunnel launch', () => {
  it('publishes a quick origin only after connection and guarded self-test, then stops once', async () => {
    const test = setup();
    const acceptOrigin = vi.fn();
    const result = await test.launcher({ port: 4912, config: test.config, acceptOrigin });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicOrigin).toBe(origin);
    expect(acceptOrigin).toHaveBeenCalledWith(origin);
    expect(test.probe.mock.calls.map(([url]) => url)).toEqual([`${origin}/pair`, `${origin}/api/health`]);
    expect(test.notices).toContain(`tunnel ready at ${origin}`);
    expect(test.spawnProcess).toHaveBeenCalledWith(
      '/fake/cloudflared',
      expect.arrayContaining(['--url', 'http://127.0.0.1:4912']),
      {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await Promise.all([result.stop(), result.stop()]);
    expect(test.children[0]?.signals).toEqual(['SIGTERM']);
    expect(fs.existsSync(path.join(test.dir, 'tunnel.pid'))).toBe(false);
  });

  it.each([
    [200, PAIRING_PAGE_MARKER, 'self_test_failed'],
    [401, 'wrong page', 'self_test_failed'],
    [503, PAIRING_PAGE_MARKER, 'self_test_failed'],
  ] as const)('closes a tunnel whose health or pairing response is unsafe (%s)', async (health, page, failure) => {
    const test = setup();
    test.probe.mockImplementation(async (url) =>
      url.endsWith('/api/health') ? { status: health, body: '' } : { status: 200, body: page },
    );
    const result = await test.launcher({ port: 4912, config: test.config });
    expect(result).toMatchObject({ ok: false, failure });
    expect(test.children[0]?.signals).toContain('SIGTERM');
  });

  it('retries edge 530 and network errors before a successful self-test', async () => {
    const test = setup();
    let pairRequests = 0;
    test.probe.mockImplementation(async (url) => {
      if (url.endsWith('/pair')) {
        pairRequests += 1;
        if (pairRequests === 1) throw new Error('temporary DNS failure');
        return { status: pairRequests === 2 ? 530 : 200, body: PAIRING_PAGE_MARKER };
      }
      return { status: pairRequests === 2 ? 530 : 401, body: '' };
    });
    const result = await test.launcher({ port: 4912, config: test.config });
    expect(result.ok).toBe(true);
    expect(pairRequests).toBe(3);
    if (result.ok) await result.stop();
  });

  it('returns a self-test failure when all probes reject', async () => {
    const test = setup();
    test.probe.mockRejectedValue(new Error('network down'));
    const result = await test.launcher({ port: 4912, config: test.config });
    expect(result).toMatchObject({ ok: false, failure: 'self_test_failed' });
    if (!result.ok) expect(result.message).toContain('network down');
  });

  it('cancels before spawn and while waiting for readiness', async () => {
    const test = setup();
    const first = new AbortController();
    first.abort();
    expect(await test.launcher({ port: 4912, config: test.config, signal: first.signal })).toMatchObject({
      ok: false,
      failure: 'exited',
    });
    expect(test.children).toHaveLength(0);
    const waiting = setup();
    (waiting.spawnProcess as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = new FakeChild();
      waiting.children.push(child);
      return child as unknown as ChildProcess;
    });
    const second = new AbortController();
    const pending = waiting.launcher({ port: 4912, config: waiting.config, signal: second.signal });
    second.abort();
    expect(await pending).toMatchObject({ ok: false, failure: 'exited' });
    expect(waiting.children[0]?.signals).toContain('SIGTERM');
  });

  it('times out without readiness and reports the output tail', async () => {
    const test = setup();
    (test.spawnProcess as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = new FakeChild();
      test.children.push(child);
      queueMicrotask(() => child.stderr.emit('data', Buffer.from('still connecting')));
      return child as unknown as ChildProcess;
    });
    const result = await test.launcher({ port: 4912, config: test.config });
    expect(result).toMatchObject({ ok: false, failure: 'timeout' });
    if (!result.ok) expect(result.message).toContain('still connecting');
  });

  it('reports a spawn throw, an emitted spawn error, and premature exit', async () => {
    const thrown = setup();
    (thrown.spawnProcess as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    expect(await thrown.launcher({ port: 4912, config: thrown.config })).toMatchObject({
      ok: false,
      failure: 'spawn_failed',
    });
    const emitted = setup();
    (emitted.spawnProcess as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = new FakeChild();
      emitted.children.push(child);
      queueMicrotask(() => child.emit('error', new Error('exec failed')));
      return child as unknown as ChildProcess;
    });
    expect(await emitted.launcher({ port: 4912, config: emitted.config })).toMatchObject({
      ok: false,
      failure: 'spawn_failed',
    });
    const exited = setup();
    (exited.spawnProcess as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = new FakeChild();
      exited.children.push(child);
      queueMicrotask(() => child.exit(7));
      return child as unknown as ChildProcess;
    });
    expect(await exited.launcher({ port: 4912, config: exited.config })).toMatchObject({
      ok: false,
      failure: 'exited',
    });
  });

  it('notifies the host when a ready quick tunnel exits unexpectedly', async () => {
    const test = setup();
    const result = await test.launcher({ port: 4912, config: test.config });
    expect(result.ok).toBe(true);
    test.children[0]?.exit(3);
    expect(test.exits[0]).toContain('code 3');
    if (result.ok) await result.stop();
  });

  it('uses a named hostname, copies a token privately, and recovers after exit', async () => {
    const token = path.join(stateDir(), 'secret');
    fs.writeFileSync(token, '  secret-token  ');
    const config = { kind: 'named', hostname: 'home.example.com', tokenFile: token, name: 'home' } as const;
    const test = setup(config);
    const result = await test.launcher({ port: 4912, config });
    expect(result).toMatchObject({ ok: true, publicOrigin: 'https://home.example.com' });
    const runtimeToken = path.join(test.dir, 'tunnel.token');
    expect(fs.readFileSync(runtimeToken, 'utf8')).toBe('secret-token');
    expect(fs.statSync(runtimeToken).mode & 0o777).toBe(0o600);
    expect(test.spawnProcess).toHaveBeenCalledWith(
      '/fake/cloudflared',
      expect.arrayContaining(['--token-file', runtimeToken, 'home']),
      expect.anything(),
    );
    test.children[0]?.exit(1);
    await vi.waitFor(() => expect(test.children).toHaveLength(2));
    await vi.waitFor(() => expect(test.notices.some((message) => message.includes('recovered'))).toBe(true));
    expect(test.exits).toHaveLength(0);
    if (result.ok) await result.stop();
    expect(fs.existsSync(runtimeToken)).toBe(false);
  });

  it('exhausts three named restart attempts after repeated launch failures', async () => {
    const config = { kind: 'named', hostname: 'home.example.com' } as const;
    const test = setup(config);
    const result = await test.launcher({ port: 4912, config });
    expect(result.ok).toBe(true);
    (test.spawnProcess as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('offline');
    });
    test.children[0]?.exit(1);
    await vi.waitFor(() => expect(test.exits).toHaveLength(1));
    expect(test.exits[0]).toContain('after 3 attempts');
    expect(test.children).toHaveLength(1);
    if (result.ok) await result.stop();
  });
});

describe('stale tunnel cleanup', () => {
  it('removes a token when no pid record remains and ignores malformed records', () => {
    const dir = stateDir();
    const notice = vi.fn();
    fs.writeFileSync(path.join(dir, 'tunnel.token'), 'secret');
    reapStaleTunnel(dir, notice);
    expect(fs.existsSync(path.join(dir, 'tunnel.token'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'tunnel.pid'), 'invalid json');
    reapStaleTunnel(dir, notice);
    expect(fs.existsSync(path.join(dir, 'tunnel.pid'))).toBe(true);
    expect(notice).not.toHaveBeenCalled();
  });

  it('does not reap a tunnel whose owner still lives', () => {
    const dir = stateDir();
    fs.writeFileSync(
      path.join(dir, 'tunnel.pid'),
      JSON.stringify({ pid: 22, ownerPid: process.pid, startedAt: Date.now() }),
    );
    reapStaleTunnel(dir, vi.fn());
    expect(fs.existsSync(path.join(dir, 'tunnel.pid'))).toBe(true);
  });

  it('clears records owned by a dead process without killing an invalid or old pid', () => {
    const dir = stateDir();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      throw new Error(`unexpected kill ${String(pid)}`);
    });
    try {
      for (const record of [
        { pid: -1, ownerPid: 999_999, startedAt: Date.now() },
        { pid: 22, ownerPid: 999_999, startedAt: 0 },
      ]) {
        fs.writeFileSync(path.join(dir, 'tunnel.pid'), JSON.stringify(record));
        fs.writeFileSync(path.join(dir, 'tunnel.token'), 'secret');
        reapStaleTunnel(dir, vi.fn());
        expect(fs.existsSync(path.join(dir, 'tunnel.pid'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'tunnel.token'))).toBe(false);
      }
      expect(kill).toHaveBeenCalledTimes(2);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('binary discovery', () => {
  it('skips empty and non-executable PATH entries and finds an executable', () => {
    const dir = stateDir();
    const other = stateDir();
    fs.writeFileSync(path.join(dir, 'cloudflared'), '');
    fs.writeFileSync(path.join(other, 'cloudflared'), '');
    fs.chmodSync(path.join(other, 'cloudflared'), 0o700);
    expect(findCloudflared({ PATH: ['', dir, other].join(path.delimiter) })).toBe(path.join(other, 'cloudflared'));
    expect(findCloudflared({ PATH: dir })).toBeUndefined();
  });
});
