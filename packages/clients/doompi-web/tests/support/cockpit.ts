import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { type FakeSession, startFakeSession } from './fakeSession.ts';
import { startRunnerApiSocket } from './runnerRuns.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const binary = path.join(packageRoot, 'dist', 'bin', 'serve.mjs');

/**
 * A stand-in doompi-server for the create-session flow: registers itself the
 * way the real bin would and stays alive until the fixture kills it.
 */
const REGISTERING_SERVER = `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(value('--registry-dir'), 'sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, value('--session-id') + '.json'), JSON.stringify({
  version: 1,
  id: value('--session-id'),
  name: value('--name'),
  cwd: process.cwd(),
  socketPath: value('--listen'),
  tokenFile: value('--auth-token-file'),
  pid: process.pid,
  createdAt: new Date().toISOString(),
}));
setInterval(() => {}, 1000);
`;

const FAILING_SERVER = `#!/usr/bin/env node
process.stderr.write('the agent binary is missing\\n');
process.exit(3);
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || address === null) {
        probe.close(() => reject(new Error('Could not reserve a port.')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still binding.
    }
    if (Date.now() > deadline) throw new Error(`doompi-web did not answer on ${url}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Kills every process the registry still names, except this one. */
function killRegistered(registryDir: string): void {
  const recordsDir = path.join(registryDir, 'sessions');
  let names: string[] = [];
  try {
    names = fs.readdirSync(recordsDir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8')) as { pid?: number };
      if (typeof record.pid === 'number' && record.pid !== process.pid) process.kill(record.pid);
    } catch {
      // Already gone, or not ours to kill.
    }
  }
}

export interface CockpitFixture {
  /** Every registered fake session, in registration order. */
  sessions: FakeSession[];
  /** The first session, which the cockpit auto-focuses; single-session specs read this. */
  session: FakeSession;
  registryDir: string;
  /** The isolated workflow-mcp registry home the spawned hub watches. */
  workflowHome: string;
  /** The isolated doom-runner store root the spawned hub watches. */
  runnerStore: string;
  /** The isolated Pi agent directory the hub's provider auth reads; specs write auth.json here. */
  agentDir: string;
  url: string;
}

interface CockpitOptions {
  sessionCount: number;
  /** Which stand-in the hub launches for created sessions: one that registers, or one that fails. */
  spawnStub: 'ok' | 'fail';
  /** Which bundle to serve: the package's own dist, or the synced-style bundle global setup built. */
  assets: 'packaged' | 'synced';
}

/**
 * Runs the published executable in hub mode against scripted sessions.
 *
 * Spawning `dist/bin/serve.mjs` rather than importing the server keeps the
 * static asset resolution and the bin wiring inside what the test covers. Each
 * fake session registers itself in a throwaway registry directory, exactly the
 * way a real doompi-server announces itself.
 */
export const test = base.extend<CockpitOptions & { cockpit: CockpitFixture }>({
  sessionCount: [1, { option: true }],
  spawnStub: ['ok', { option: true }],
  assets: ['packaged', { option: true }],
  page: async ({ page, cockpit }, use) => {
    await page.goto(`${cockpit.url}/pair`);
    await page.waitForURL(`${cockpit.url}/`);
    await page.getByTestId('cockpit').waitFor();
    await page.goto('about:blank');
    await use(page);
  },
  cockpit: async ({ sessionCount, spawnStub, assets }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-hub-e2e-'));
    const registryDir = path.join(root, 'run');
    const stateDir = path.join(root, 'state');
    const stub = path.join(root, 'fake-doompi-server');
    fs.writeFileSync(stub, spawnStub === 'ok' ? REGISTERING_SERVER : FAILING_SERVER, { mode: 0o755 });

    // An isolated Pi agent directory: doom-runner keeps its store under it, and
    // runner specs write records there.
    const agentDir = path.join(root, 'pi-agent');
    const runnerStore = path.join(agentDir, 'doom-runner');
    fs.mkdirSync(agentDir, { recursive: true });

    // Each fake session serves a package API on its own socket, the way a real
    // doompi-server does, so the hub has something to proxy to.
    const apiSockets = path.join(root, 'api-sockets');
    fs.mkdirSync(apiSockets, { recursive: true });
    const sessions: FakeSession[] = [];
    const sessionApiStops: Array<() => Promise<void>> = [];
    for (let index = 0; index < sessionCount; index += 1) {
      const id = `s${index + 1}`;
      const apiSocketPath = path.join(apiSockets, `${id}.sock`);
      sessions.push(await startFakeSession({ id, name: `session-${index + 1}`, registryDir, apiSocketPath }));
      sessionApiStops.push(startRunnerApiSocket(runnerStore, id, apiSocketPath));
    }

    const port = await freePort();
    // An isolated workflow home: the hub must never watch the developer's
    // real registry from a test, and workflow specs write runs into this one.
    const workflowHome = path.join(root, 'workflow-mcp');
    // The hub also resolves provider auth from the environment; the developer's
    // own keys must not make a throwaway hub look signed in.
    const env: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_MCP_HOME: workflowHome, PI_CODING_AGENT_DIR: agentDir };
    for (const key of Object.keys(env)) if (/_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/.test(key)) delete env[key];
    const syncedDist = process.env.DOOMPI_E2E_SYNCED_DIST;
    if (assets === 'synced' && !syncedDist) throw new Error('global setup did not publish the synced bundle');
    // Assets are always explicit: without this, the server would prefer the
    // developer's machine-wide ~/.doompi/web bundle over the freshly built one.
    const assetsDir = assets === 'synced' && syncedDist ? syncedDist : path.join(packageRoot, 'dist', 'web');
    const child: ChildProcess = spawn(
      process.execPath,
      [
        binary,
        '--registry-dir',
        registryDir,
        '--state-dir',
        stateDir,
        '--spawn-command',
        stub,
        '--port',
        String(port),
        '--assets',
        assetsDir,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    );

    const logs: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(url);
    } catch (error) {
      child.kill('SIGKILL');
      for (const session of sessions) await session.close();
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    }

    await use({ sessions, session: sessions[0], registryDir, workflowHome, runnerStore, agentDir, url });

    child.kill('SIGTERM');
    for (const stop of sessionApiStops) await stop();
    for (const session of sessions) await session.close();
    killRegistered(registryDir);
    fs.rmSync(root, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
