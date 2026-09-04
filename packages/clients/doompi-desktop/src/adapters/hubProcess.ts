import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { hubArguments, hubEnvironment } from '../services/hubLaunch.ts';
import type { ComputerUseHost } from '../services/computerUseHost.ts';
import type { HubLaunchPlan, RunningHub } from '../types/hub.ts';
import { attachComputerUseHostBridge } from './computerUseHostBridge.ts';

const HEALTH_TIMEOUT_MS = 10 * 60_000;
const HEALTH_POLL_MS = 150;
const STOP_TIMEOUT_MS = 10_000;

const healthUrl = (host: string, port: number): string => `http://${host}:${String(port)}/api/health`;

/** Whether a DoomPi cockpit, rather than something else, holds this address. */
export async function cockpitAnswers(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(healthUrl(host, port), { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether this process could bind the address itself. */
export async function portIsFree(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** An unused port from the ephemeral range, for when the default is taken. */
export async function freePort(host: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.once('listening', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('The operating system did not report a port.')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
    probe.listen(0, host);
  });
}

async function waitForHealth(host: string, port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The cockpit exited before it finished starting (code ${String(child.exitCode)}).`);
    }
    if (await cockpitAnswers(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`The cockpit did not answer on ${healthUrl(host, port)} within ${String(HEALTH_TIMEOUT_MS)}ms.`);
}

/** Uses Electron's background helper as Node so child sessions never become Dock apps. */
export function nodeRuntimeExecutable(
  mainExecutable: string,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  if (platform !== 'darwin') return mainExecutable;
  const name = path.basename(mainExecutable);
  const helper = path.resolve(
    path.dirname(mainExecutable),
    '..',
    'Frameworks',
    `${name} Helper.app`,
    'Contents',
    'MacOS',
    `${name} Helper`,
  );
  return exists(helper) ? helper : mainExecutable;
}
/**
 * Starts the staged cockpit, or attaches to one that is already serving.
 *
 * Attaching matters more than it looks: a cockpit started from the terminal and
 * this app are the same program over the same session registry, so a second
 * copy would fight the first for the port and the sessions rather than showing
 * the user what is already running.
 */
export async function startHub(
  plan: HubLaunchPlan,
  onNotice: (message: string) => void = () => {},
  computerUseHost?: ComputerUseHost,
): Promise<RunningHub> {
  const url = `http://${plan.host}:${String(plan.port)}`;
  if (await cockpitAnswers(plan.host, plan.port)) {
    onNotice(`attaching to the cockpit already serving at ${url}`);
    return { url, owned: false, stop: async () => {} };
  }

  const child = spawn(nodeRuntimeExecutable(process.execPath), hubArguments(plan), {
    cwd: plan.cwd,
    env: hubEnvironment(process.env, plan.entry),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const computerUseBridge =
    computerUseHost === undefined ? undefined : attachComputerUseHostBridge(child, computerUseHost, onNotice);
  child.stdout?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));
  child.stderr?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));

  try {
    await waitForHealth(plan.host, plan.port, child);
  } catch (error) {
    await computerUseBridge?.close();
    child.kill('SIGKILL');
    throw error;
  }
  onNotice(`cockpit serving at ${url}`);

  const stop = async (): Promise<void> => {
    await computerUseBridge?.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    // A cockpit with live sessions can take a moment to stand them down, but a
    // quit that hangs on it is worse than one that is abrupt.
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  return { url, owned: true, stop };
}
