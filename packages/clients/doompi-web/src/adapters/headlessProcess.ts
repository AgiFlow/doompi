import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { HEADLESS_COMMAND_ENV, headlessArguments, headlessEndpoint } from '../services/headlessLaunch';

const PROBE_TIMEOUT_MS = 500;
const PROBE_INTERVAL_MS = 250;
const READY_TIMEOUT_MS = 10 * 60_000;

/** A headless process this presentation server started and therefore shuts down. */
export interface HeadlessProcess {
  /** Endpoint selected for this child, which may differ when the default port is occupied. */
  url: string;
  /** Credential the presentation proxy forwards to the child. */
  token: string;
  close: () => Promise<void>;
}

export interface HeadlessProcessOptions {
  /** Headless endpoint to occupy, already defaulted by the caller. */
  url: string;
  environment: NodeJS.ProcessEnv;
  onNotice: (message: string) => void;
}

async function listening(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * Locates the client-neutral entry without importing it.
 *
 * A packaged client points at its own staged artifact; a plain install resolves
 * the DoomPi dependency this package already declares.
 */
function resolveHeadlessEntry(environment: NodeJS.ProcessEnv, parentUrl: string): string | undefined {
  const configured = environment[HEADLESS_COMMAND_ENV];
  if (configured !== undefined && configured !== '') return configured;
  try {
    const manifest = createRequire(parentUrl).resolve('@agimon-ai/doompi/package.json');
    const entry = path.join(path.dirname(manifest), 'dist', 'bin', 'serve.mjs');
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeTokenFile(token: string): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-'));
  const file = path.join(directory, 'auth-token');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return { directory, file };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function availablePort(host: string): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, resolve);
  });
  const address = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitUntilReady(child: ChildProcess, url: string, spawnFailure: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const failure = spawnFailure();
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`The headless server exited before it was ready (code ${String(child.exitCode)}).`);
    try {
      const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = (await response.json()) as { ok?: unknown; role?: unknown };
        if (health.ok === true && health.role === 'hub') return;
      }
    } catch {
      // The child may still be syncing or binding its listener.
    }
    if (Date.now() >= deadline)
      throw new Error(`The headless server did not become healthy on ${url} within ${String(READY_TIMEOUT_MS)}ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}

/**
 * Starts the client-neutral process the browser shell needs, so `doompi-web`
 * is a single command.
 *
 * An occupied default endpoint belongs to someone else. Start an authenticated
 * child on an available port instead of attaching without its credential.
 */
export async function startHeadless(options: HeadlessProcessOptions): Promise<HeadlessProcess> {
  const { host } = headlessEndpoint(options.url);
  let { port } = headlessEndpoint(options.url);
  const endpoint = new URL(options.url);
  if (await listening(host, port)) {
    port = await availablePort(host);
    endpoint.port = String(port);
    options.onNotice(`${options.url} is occupied; starting a separate headless server on ${endpoint.origin}`);
  }
  const url = endpoint.origin;

  const entry = resolveHeadlessEntry(options.environment, import.meta.url);
  if (entry === undefined)
    throw new Error(`Headless server not found; start one on ${options.url} or pass --headless-url.`);

  const token = crypto.randomBytes(32).toString('hex');
  const { directory, file } = writeTokenFile(token);
  const discard = (): void => fs.rmSync(directory, { force: true, recursive: true });
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, headlessArguments({ entry, port, tokenFile: file }), {
      env: options.environment,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  } catch (error) {
    discard();
    throw error;
  }
  let spawnFailure: Error | undefined;
  child.on('error', (error) => {
    spawnFailure = error;
  });
  try {
    await waitUntilReady(child, url, () => spawnFailure);
  } catch (error) {
    if (child.pid !== undefined) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    discard();
    throw error;
  }

  options.onNotice(`headless server on ${url}`);
  let closePromise: Promise<void> | undefined;
  return {
    url,
    token,
    close: () =>
      (closePromise ??= (async () => {
        child.kill('SIGTERM');
        await waitForExit(child);
        discard();
      })()),
  };
}
