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
const READY_TIMEOUT_MS = 120_000;

/** A headless process this presentation server started and therefore shuts down. */
export interface HeadlessProcess {
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

async function waitUntilReady(child: ChildProcess, host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (await listening(host, port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}

/**
 * Starts the client-neutral process the browser shell needs, so `doompi-web`
 * is a single command.
 *
 * An endpoint that already answers belongs to someone else: the presentation
 * server proxies to it untouched and starts nothing.
 */
export async function startHeadless(options: HeadlessProcessOptions): Promise<HeadlessProcess | undefined> {
  const { host, port } = headlessEndpoint(options.url);
  if (await listening(host, port)) {
    options.onNotice(`using the headless server already listening on ${options.url}`);
    return undefined;
  }

  const entry = resolveHeadlessEntry(options.environment, import.meta.url);
  if (entry === undefined) {
    options.onNotice(`headless server not found; start one on ${options.url} or pass --headless-url`);
    return undefined;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const { directory, file } = writeTokenFile(token);
  const child = spawn(process.execPath, headlessArguments({ entry, port, tokenFile: file }), {
    env: options.environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const discard = (): void => fs.rmSync(directory, { force: true, recursive: true });
  const ready = await waitUntilReady(child, host, port);
  if (!ready) {
    child.kill('SIGTERM');
    await waitForExit(child);
    discard();
    options.onNotice(`the headless server did not start on ${options.url}`);
    return undefined;
  }

  options.onNotice(`headless server on ${options.url}`);
  let closePromise: Promise<void> | undefined;
  return {
    token,
    close: () =>
      (closePromise ??= (async () => {
        child.kill('SIGTERM');
        await waitForExit(child);
        discard();
      })()),
  };
}
