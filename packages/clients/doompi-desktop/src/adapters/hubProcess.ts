import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { headlessArguments, hubArguments, hubEnvironment } from '../services/hubLaunch';
import type { ComputerUseHost } from '../services/computerUseHost';
import type { HubLaunchPlan, RunningHub } from '../types/hub';
import { attachComputerUseHostBridge } from './computerUseHostBridge';

const HEALTH_TIMEOUT_MS = 10 * 60_000;
const HEALTH_POLL_MS = 150;
const STOP_TIMEOUT_MS = 10_000;

const healthUrl = (host: string, port: number): string => `http://${host}:${String(port)}/api/health`;

/** Whether this process could bind the address itself. */
export async function portIsFree(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** An unused port from the ephemeral range. */
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

async function waitForHealth(host: string, port: number, child: ChildProcess, label: string): Promise<void> {
  const endpoint = healthUrl(host, port);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The ${label} process exited before it finished starting (code ${String(child.exitCode)}).`);
    }
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The process is still binding or composing its runtime.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`The ${label} process did not answer on ${endpoint} within ${String(HEALTH_TIMEOUT_MS)}ms.`);
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

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, STOP_TIMEOUT_MS);
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

/** Starts the headless server and the presentation proxy as one desktop unit. */
export async function startHub(
  plan: HubLaunchPlan,
  onNotice: (message: string) => void = () => {},
  computerUseHost?: ComputerUseHost,
): Promise<RunningHub> {
  const url = `http://${plan.host}:${String(plan.port)}`;
  const headless = spawn(nodeRuntimeExecutable(process.execPath), headlessArguments(plan), {
    cwd: plan.cwd,
    env: hubEnvironment(process.env, plan.entry),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let computerUseBridge: ReturnType<typeof attachComputerUseHostBridge> | undefined;
  headless.stdout?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));
  headless.stderr?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));

  let presentation: ChildProcess | undefined;
  try {
    computerUseBridge =
      computerUseHost === undefined ? undefined : attachComputerUseHostBridge(headless, computerUseHost, onNotice);
    await waitForHealth(plan.host, plan.headlessPort, headless, 'headless server');
    presentation = spawn(nodeRuntimeExecutable(process.execPath), hubArguments(plan), {
      cwd: plan.cwd,
      env: hubEnvironment(process.env, plan.entry),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    presentation.stdout?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));
    presentation.stderr?.on('data', (chunk: Buffer) => onNotice(chunk.toString().trimEnd()));
    await waitForHealth(plan.host, plan.port, presentation, 'web presentation');
  } catch (error) {
    await computerUseBridge?.close();
    if (presentation !== undefined) presentation.kill('SIGKILL');
    headless.kill('SIGKILL');
    throw error;
  }

  onNotice(`headless server serving at http://${plan.host}:${String(plan.headlessPort)}`);
  onNotice(`web presentation serving at ${url}`);
  return {
    url,
    owned: true,
    stop: async () => {
      await computerUseBridge?.close();
      if (presentation !== undefined) await stopChild(presentation);
      await stopChild(headless);
    },
  };
}
