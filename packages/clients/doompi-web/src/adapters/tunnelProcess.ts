import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  describeTunnelFailure,
  extractTunnelUrl,
  mentionsRegisteredConnection,
  tunnelArgs,
} from '../services/tunnelOutput.ts';
import { PAIRING_PAGE_MARKER } from '../services/pairingPage.ts';
import {
  PAIRING_PAGE_ROUTE,
  type TunnelConfig,
  type TunnelLauncher,
  type TunnelStartInput,
  type TunnelStartResult,
} from '../types/remoteAccess.ts';

/** Explicit binary path, ahead of a PATH scan. */
export const CLOUDFLARED_ENV = 'DOOMPI_CLOUDFLARED';
const START_TIMEOUT_MS = 45_000;
const TERMINATE_GRACE_MS = 2000;
const SELF_TEST_ATTEMPTS = 10;
const SELF_TEST_RETRY_MS = 500;
const NAMED_RESTART_ATTEMPTS = 3;
const NAMED_RESTART_BASE_DELAY_MS = 500;
const NAMED_RESTART_MAX_DELAY_MS = 4000;
const NAMED_RESTART_STABLE_MS = 60_000;
/** Lines of process output kept for a failure report. */
const LOG_TAIL = 20;
const UNAUTHORIZED = 401;
/** Cloudflare has the DNS route but no connector has registered yet. */
const EDGE_TUNNEL_UNAVAILABLE = 530;
const OK = 200;
const PID_FILE = 'tunnel.pid';
const TOKEN_FILE = 'tunnel.token';
const FILE_MODE = 0o600;
/** A pid file older than this is stale beyond usefulness and the pid has likely been recycled. */
const PID_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProbeResult {
  status: number;
  body: string;
}

export interface TunnelProcessOptions {
  /** Explicit binary, ahead of the env var and the PATH scan. */
  cloudflaredPath?: string;
  stateDir: string;
  onNotice?: (message: string) => void;
  /** Test seam: stands in for node:child_process.spawn. */
  spawnProcess?: typeof spawn;
  /** Test seam: reaches the tunnel from outside, so the self-test needs no network. */
  probe?: (url: string, signal: AbortSignal) => Promise<ProbeResult>;
  /** Test seam: production waits briefly for a new public hostname to propagate. */
  selfTestRetryMs?: number;
  /** Test seam: production bounds the complete startup, including its self-test. */
  startTimeoutMs?: number;
  /** Test seam: production backs named-tunnel restarts off from 500 ms. */
  restartBaseDelayMs?: number;
  /** Test seam: production resets the rapid-crash budget after one stable minute. */
  restartStableMs?: number;
  /** Called after a quick tunnel exits, or after named-tunnel recovery is exhausted. */
  onExit?: (message: string) => void;
}

/**
 * Finds cloudflared without a shell.
 *
 * A manual scan rather than `which`: spawning a shell to locate a binary is a
 * quoting hazard for no benefit, and this also works the same on every platform.
 */
export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared'];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable; keep looking.
      }
    }
  }
  return undefined;
}

async function defaultProbe(url: string, signal: AbortSignal): Promise<ProbeResult> {
  const response = await fetch(url, { redirect: 'manual', signal });
  return { status: response.status, body: await response.text() };
}

/**
 * Kills a tunnel left behind by a hub that could not clean up after itself.
 *
 * A SIGKILLed hub never runs its exit handler, and the child is not detached so
 * it is reparented rather than killed. It then holds the tunnel open against a
 * dead port. This is the sweep on the next start.
 *
 * The residual risk is pid reuse after a reboot. The age window narrows it and
 * on Linux the command line is checked; macOS has no equally cheap check, so
 * there the window stands.
 */
interface TunnelPidRecord {
  pid?: unknown;
  ownerPid?: unknown;
  startedAt?: unknown;
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Only ESRCH proves the owner is gone; permission and platform errors fail safe. */
function ownerMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function reapStaleTunnel(stateDir: string, onNotice: (message: string) => void): void {
  const pidPath = path.join(stateDir, PID_FILE);
  const tokenPath = path.join(stateDir, TOKEN_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fs.rmSync(tokenPath, { force: true });
    return; // No pid file is the normal case; other read failures are unsafe to guess through.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // A malformed record cannot prove that its owner is gone.
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const record = parsed as TunnelPidRecord;
  if (Object.hasOwn(record, 'ownerPid')) {
    if (!validPid(record.ownerPid) || ownerMayBeAlive(record.ownerPid)) return;
  }

  fs.rmSync(tokenPath, { force: true });
  fs.rmSync(pidPath, { force: true });
  const pid = validPid(record.pid) ? record.pid : undefined;
  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : 0;
  if (pid === undefined || Date.now() - startedAt > PID_FILE_MAX_AGE_MS) return;
  if (process.platform === 'linux') {
    try {
      if (!fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('cloudflared')) return;
    } catch {
      return; // The process is gone.
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
    onNotice(`stopped a tunnel left running by a previous hub (pid ${String(pid)})`);
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

function tailOf(lines: readonly string[]): string {
  return lines.slice(-LOG_TAIL).join('').trim();
}

/** Copies a named tunnel token to a private runtime file understood by cloudflared. */
function writeTokenFile(config: TunnelConfig, stateDir: string): string | undefined {
  if (config.kind !== 'named' || config.tokenFile === undefined) return undefined;
  let token: string;
  let sourcePath: string;
  try {
    sourcePath = fs.realpathSync(config.tokenFile);
    token = fs.readFileSync(sourcePath, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (token === '') return undefined;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(stateDir, TOKEN_FILE);
  let existingTarget: string | undefined;
  try {
    existingTarget = fs.realpathSync(tokenPath);
  } catch {
    // Missing is the normal state before launch.
  }
  if (sourcePath === path.resolve(tokenPath) || sourcePath === existingTarget) {
    throw new Error('The configured tunnel token file cannot also be DoomPi runtime token storage.');
  }
  fs.rmSync(tokenPath, { force: true });
  fs.writeFileSync(tokenPath, token, { mode: FILE_MODE });
  fs.chmodSync(tokenPath, FILE_MODE);
  return tokenPath;
}

export function createTunnelLauncher(options: TunnelProcessOptions): TunnelLauncher {
  const notice = options.onNotice ?? ((): void => {});
  const restartBaseDelayMs = options.restartBaseDelayMs ?? NAMED_RESTART_BASE_DELAY_MS;
  const restartStableMs = options.restartStableMs ?? NAMED_RESTART_STABLE_MS;

  return async function launch(input: TunnelStartInput): Promise<TunnelStartResult> {
    let stopped = false;
    let activeStop: (() => Promise<void>) | undefined;
    let stopPromise: Promise<void> | undefined;
    let recoveryPromise: Promise<void> | undefined;
    let pendingExit: string | undefined;
    let restartCount = 0;
    let lastReadyAt = 0;
    const recoveryAbort = new AbortController();
    const signal =
      input.signal === undefined ? recoveryAbort.signal : AbortSignal.any([input.signal, recoveryAbort.signal]);
    const supervisedInput: TunnelStartInput = { ...input, signal };

    function queueUnexpectedExit(message: string): void {
      if (stopped) return;
      if (input.config.kind === 'quick') {
        options.onExit?.(message);
        return;
      }
      if (recoveryPromise !== undefined) {
        pendingExit = message;
        return;
      }
      beginRecovery(message);
    }

    const single = createSingleTunnelLauncher({ ...options, onExit: queueUnexpectedExit });

    async function waitForRestart(attempt: number): Promise<void> {
      if (recoveryAbort.signal.aborted) return;
      const delayMs = Math.min(restartBaseDelayMs * 2 ** (attempt - 1), NAMED_RESTART_MAX_DELAY_MS);
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = (): void => {
          clearTimeout(timer);
          recoveryAbort.signal.removeEventListener('abort', done);
          resolve();
        };
        timer = setTimeout(done, delayMs);
        recoveryAbort.signal.addEventListener('abort', done, { once: true });
        if (recoveryAbort.signal.aborted) done();
      });
    }

    async function recover(initialMessage: string): Promise<void> {
      if (Date.now() - lastReadyAt >= restartStableMs) restartCount = 0;
      let lastFailure = initialMessage;
      while (!stopped && restartCount < NAMED_RESTART_ATTEMPTS) {
        restartCount += 1;
        notice(
          `cloudflared stopped; restarting named tunnel (attempt ${String(restartCount)} of ${String(NAMED_RESTART_ATTEMPTS)})`,
        );
        await waitForRestart(restartCount);
        if (stopped) return;

        const outcome = await single(supervisedInput);
        if (stopped) {
          if (outcome.ok) await outcome.stop().catch(() => undefined);
          return;
        }
        if (!outcome.ok) {
          lastFailure = outcome.message;
          continue;
        }
        activeStop = outcome.stop;
        lastReadyAt = Date.now();
        notice(`named tunnel recovered at ${outcome.publicOrigin}`);
        return;
      }

      if (!stopped) {
        options.onExit?.(
          `${initialMessage}\nNamed tunnel recovery failed after ${String(NAMED_RESTART_ATTEMPTS)} attempts. Last failure: ${lastFailure}`,
        );
      }
    }

    function beginRecovery(message: string): void {
      recoveryPromise = recover(message)
        .catch((error: unknown) => {
          if (!stopped) {
            const cause = error instanceof Error ? error.message : String(error);
            options.onExit?.(`${message}\nNamed tunnel recovery failed: ${cause}`);
          }
        })
        .finally(() => {
          recoveryPromise = undefined;
          const queued = pendingExit;
          pendingExit = undefined;
          if (queued !== undefined && !stopped) beginRecovery(queued);
        });
    }

    const initial = await single(supervisedInput);
    if (!initial.ok) {
      stopped = true;
      recoveryAbort.abort();
      return initial;
    }
    activeStop = initial.stop;
    lastReadyAt = Date.now();

    const stop = async (): Promise<void> => {
      if (stopPromise !== undefined) return await stopPromise;
      stopped = true;
      recoveryAbort.abort();
      const recovering = recoveryPromise;
      stopPromise = (async () => {
        await activeStop?.().catch(() => undefined);
        await recovering?.catch(() => undefined);
        fs.rmSync(path.join(options.stateDir, PID_FILE), { force: true });
        fs.rmSync(path.join(options.stateDir, TOKEN_FILE), { force: true });
      })();
      return await stopPromise;
    };

    return { ok: true, publicOrigin: initial.publicOrigin, stop };
  };
}

/** Starts one cloudflared child; the exported launcher supervises successive named-tunnel children. */
function createSingleTunnelLauncher(options: TunnelProcessOptions): TunnelLauncher {
  const notice = options.onNotice ?? ((): void => {});
  const spawnProcess = options.spawnProcess ?? spawn;
  const probe = options.probe ?? defaultProbe;
  const selfTestRetryMs = options.selfTestRetryMs ?? SELF_TEST_RETRY_MS;
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const pidPath = path.join(options.stateDir, PID_FILE);
  const runtimeTokenPath = path.join(options.stateDir, TOKEN_FILE);

  return async function launch(input: TunnelStartInput): Promise<TunnelStartResult> {
    if (input.signal?.aborted === true) {
      return { ok: false, failure: 'exited', message: 'Tunnel startup was cancelled.' };
    }
    const binary = options.cloudflaredPath ?? process.env[CLOUDFLARED_ENV] ?? findCloudflared();
    if (binary === undefined || binary === '') {
      return { ok: false, failure: 'not_installed', message: describeTunnelFailure('not_installed') };
    }

    let tokenPath: string | undefined;
    try {
      tokenPath = writeTokenFile(input.config, options.stateDir);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, failure: 'spawn_failed', message: `${describeTunnelFailure('spawn_failed')} ${cause}` };
    }
    const args = tunnelArgs(input.config, input.port, tokenPath);
    let child: ChildProcess;
    try {
      // Never detached and never unref'd. A detached child becomes a process
      // group leader that survives the terminal's SIGINT, which is exactly the
      // orphaned public tunnel this must avoid. Contrast serverSpawner.ts,
      // which detaches on purpose because sessions outlive the hub.
      child = spawnProcess(binary, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      fs.rmSync(runtimeTokenPath, { force: true });
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, failure: 'spawn_failed', message: `${describeTunnelFailure('spawn_failed')} ${cause}` };
    }

    const lines: string[] = [];
    let stopped = false;
    let settle: ((result: TunnelStartResult) => void) | undefined;
    let selfTestStarted = false;
    const selfTestAbort = new AbortController();

    const killTree = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    };
    const onProcessExit = (): void => {
      // Synchronous on purpose: async work in an 'exit' handler never runs.
      // This is the net under process.exit(), an uncaught exception, and an
      // unhandled rejection, none of which reach the graceful close path.
      fs.rmSync(runtimeTokenPath, { force: true });
      try {
        if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    process.once('exit', onProcessExit);

    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      process.off('exit', onProcessExit);
      fs.rmSync(pidPath, { force: true });
      fs.rmSync(runtimeTokenPath, { force: true });
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const escalate = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, TERMINATE_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(escalate);
          resolve();
        });
        killTree();
      });
    };

    try {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        pidPath,
        JSON.stringify({ pid: child.pid, ownerPid: process.pid, startedAt: Date.now(), command: binary }),
        { mode: FILE_MODE },
      );
    } catch {
      // The reaper is a safety net, not a requirement; losing it does not stop
      // the tunnel from coming up.
    }

    const configuredOrigin = input.config.kind === 'named' ? `https://${input.config.hostname}` : undefined;
    let seenUrl = configuredOrigin;
    let seenConnection = false;

    const waitToRetry = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          selfTestAbort.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, selfTestRetryMs);
        selfTestAbort.signal.addEventListener('abort', done, { once: true });
      });
    };

    /** Proves end to end that pairing is reachable and that everything else is not. */
    const runSelfTest = async (origin: string): Promise<TunnelStartResult> => {
      let pairResponse: ProbeResult | undefined;
      let healthResponse: ProbeResult | undefined;
      let cause = 'fetch failed';
      for (let attempt = 0; attempt < SELF_TEST_ATTEMPTS && !selfTestAbort.signal.aborted; attempt += 1) {
        try {
          pairResponse = await probe(`${origin}${PAIRING_PAGE_ROUTE}`, selfTestAbort.signal);
          healthResponse = await probe(`${origin}/api/health`, selfTestAbort.signal);
          if (pairResponse.status !== EDGE_TUNNEL_UNAVAILABLE && healthResponse.status !== EDGE_TUNNEL_UNAVAILABLE)
            break;
          cause = `Cloudflare edge answered ${String(healthResponse.status)} before the connector registered`;
        } catch (error) {
          cause = error instanceof Error ? error.message : String(error);
        }
        if (attempt + 1 < SELF_TEST_ATTEMPTS && !selfTestAbort.signal.aborted) await waitToRetry();
      }
      if (pairResponse === undefined || healthResponse === undefined) {
        return { ok: false, failure: 'self_test_failed', message: `The tunnel did not answer: ${cause}` };
      }
      if (healthResponse.status !== UNAUTHORIZED) {
        // The agent would be on the public internet unauthenticated. This is
        // the one failure worth an automatic abort rather than a warning.
        const message = `${describeTunnelFailure('self_test_failed')} /api/health answered ${String(healthResponse.status)} through the tunnel.`;
        notice(message);
        return { ok: false, failure: 'self_test_failed', message };
      }
      if (pairResponse.status !== OK || !pairResponse.body.includes(PAIRING_PAGE_MARKER)) {
        const message = `The pairing page answered ${String(pairResponse.status)} through the tunnel.`;
        notice(message);
        return { ok: false, failure: 'self_test_failed', message };
      }
      notice(`tunnel ready at ${origin}`);
      return { ok: true, publicOrigin: origin, stop };
    };

    const consider = (chunk: string): void => {
      lines.push(chunk);
      if (settle === undefined || selfTestStarted) return;
      seenUrl ??= extractTunnelUrl(chunk);
      seenConnection ||= mentionsRegisteredConnection(chunk);
      if (seenUrl === undefined || !seenConnection) return;
      selfTestStarted = true;
      input.acceptOrigin?.(seenUrl);
      void runSelfTest(seenUrl).then((result) => settle?.(result));
    };

    child.stdout?.on('data', (data: Buffer) => consider(data.toString()));
    child.stderr?.on('data', (data: Buffer) => consider(data.toString()));

    return await new Promise<TunnelStartResult>((resolve) => {
      let deadline: ReturnType<typeof setTimeout>;
      const finish = (result: TunnelStartResult, stopProcess = !result.ok): void => {
        if (settle === undefined) return;
        settle = undefined;
        clearTimeout(deadline);
        input.signal?.removeEventListener('abort', cancel);
        selfTestAbort.abort();
        if (stopProcess) {
          void stop().then(() => resolve(result));
        } else {
          resolve(result);
        }
      };
      const cancel = (): void => {
        finish({ ok: false, failure: 'exited', message: 'Tunnel startup was cancelled.' });
      };
      settle = (result) => finish(result);
      deadline = setTimeout(() => {
        finish({
          ok: false,
          failure: 'timeout',
          message: `${describeTunnelFailure('timeout')}\n${tailOf(lines)}`,
        });
      }, startTimeoutMs);
      input.signal?.addEventListener('abort', cancel, { once: true });

      child.once('error', (error) => {
        finish({
          ok: false,
          failure: 'spawn_failed',
          message: `${describeTunnelFailure('spawn_failed')} ${error.message}`,
        });
      });

      child.once('exit', (code) => {
        process.off('exit', onProcessExit);
        fs.rmSync(runtimeTokenPath, { force: true });
        const message = `${describeTunnelFailure('exited')} (code ${String(code)})\n${tailOf(lines)}`;
        if (settle !== undefined) {
          finish({ ok: false, failure: 'exited', message }, false);
          return;
        }
        // It came up and then died: network loss, an edge rejection, or a
        // self-update. The supervisor either replaces a named connector or tells
        // the host to fail closed rather than leave an unreachable cockpit enabled.
        if (!stopped) options.onExit?.(message);
      });

      // A named tunnel already knows its hostname, but it still waits for
      // cloudflared to register an edge connection before probing the public URL.
      if (input.signal?.aborted === true) cancel();
    });
  };
}
