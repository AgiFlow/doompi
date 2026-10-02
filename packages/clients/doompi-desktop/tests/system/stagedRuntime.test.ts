import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeGlobalDoomConfig } from '@agimon-ai/doompi-config';
import { expect, it } from 'vitest';

import { freePort, nodeRuntimeExecutable } from '../../src/adapters/hubProcess';
import { headlessArguments, hubArguments, hubEnvironment, LOOPBACK_HOST } from '../../src/services/hubLaunch';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const STARTUP_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 150;
const STOP_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

function electronExecutable(): string {
  const require = createRequire(import.meta.url);
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  return nodeRuntimeExecutable(
    path.join(electronRoot, 'dist', fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim()),
  );
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The staged child did not shut down after SIGTERM.'));
    }, STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

it(
  'runs first-use sync and the real cockpit from a relocated runtime with a fresh HOME',
  async () => {
    const sourceRuntime = path.join(packageRoot, 'build', 'runtime');
    expect(fs.existsSync(sourceRuntime), 'Run the test-runtime Nx target to stage the runtime first.').toBe(true);
    const executable = electronExecutable();
    expect(fs.existsSync(executable), 'Install the Electron runtime before running this smoke test.').toBe(true);
    // macOS Unix sockets must fit in 104 bytes, including the runner lifeline suffix.
    const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dpi-'));
    const children: ChildProcess[] = [];
    let output = '';
    let shutdown: PromiseSettledResult<void>[] = [];
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_BYTES);
    };
    try {
      const runtime = path.join(root, 'runtime');
      const home = path.join(root, 'home');
      fs.mkdirSync(home, { recursive: true });
      fs.cpSync(sourceRuntime, runtime, { recursive: true, dereference: true });
      expect(fs.existsSync(path.join(home, '.pi'))).toBe(false);
      // Match Desktop's non-forcing first-launch seed, without pre-syncing or installing packages.
      initializeGlobalDoomConfig(home);
      const catalog = JSON.parse(fs.readFileSync(path.join(runtime, 'catalog', 'index.json'), 'utf8')) as {
        packages: Record<string, { archive: string }>;
      };
      expect(catalog.packages['@agimon-ai/doompi-computer-use']).toBeDefined();
      const token = randomUUID();
      const tokenFile = path.join(root, 'attach-token');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
      const headlessPort = await freePort(LOOPBACK_HOST);
      let port = await freePort(LOOPBACK_HOST);
      while (port === headlessPort) port = await freePort(LOOPBACK_HOST);
      const entry = path.join(runtime, 'doompi-web', 'dist', 'bin', 'serve.mjs');
      const headlessEntry = path.join(runtime, 'doompi', 'dist', 'bin', 'serve.mjs');
      const env = hubEnvironment(
        {
          HOME: home,
          USERPROFILE: home,
          TMPDIR: path.join(root, 'tmp'),
          PATH: '/usr/bin:/bin',
          XDG_CACHE_HOME: path.join(root, 'cache'),
          // Configure an idle model without user credentials. No prompt/provider request is sent.
          ANTHROPIC_API_KEY: 'staged-smoke-unused-key',
        },
        entry,
        true,
      );
      fs.mkdirSync(env.TMPDIR!, { recursive: true });
      const launch = (args: string[]) => {
        const child = spawn(executable, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.on('error', (error) => append(Buffer.from(error.message)));
        children.push(child);
        return child;
      };
      const ready = async (child: ChildProcess, origin: string): Promise<{ sessions?: number }> => {
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Staged child exited before readiness: ${String(child.exitCode)}\n${output}`);
          }
          try {
            const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
            if (response.ok) return (await response.json()) as { sessions?: number };
          } catch {
            // Connection refusal is expected while the real first-use sync is running.
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        throw new Error(`Staged runtime did not become ready.\n${output}`);
      };
      const headless = launch(headlessArguments({ headlessEntry, headlessPort, tokenFile }));
      const serverOrigin = `http://${LOOPBACK_HOST}:${headlessPort}`;
      const health = await ready(headless, serverOrigin);
      expect(health.sessions, 'A fresh HOME must boot without opening it as a repository.').toBe(0);
      const headers = { 'x-doompi-token': token, 'content-type': 'application/json' };
      const admission = await fetch(`${serverOrigin}/api/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Scratch' }),
      });
      const admitted = (await admission.json()) as { workspace: { id: string } };
      expect(admission.status, `${JSON.stringify(admitted)}\n${output}`).toBe(201);
      const session = await fetch(`${serverOrigin}/api/workspaces/${admitted.workspace.id}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Standalone smoke' }),
      });
      const created = (await session.json()) as { sessionId: string };
      expect(session.status, `${JSON.stringify(created)}\n${output}`).toBe(201);
      expect(created.sessionId).toBeTypeOf('string');
      expect((await ready(headless, serverOrigin)).sessions, output).toBeGreaterThan(0);
      const generated = path.join(home, '.pi', '.doom', 'sync');
      const descriptors = fs
        .readdirSync(generated, { recursive: true, withFileTypes: true })
        .filter((file) => file.isFile() && file.name === 'server.bundle.json')
        .map(
          (file) =>
            JSON.parse(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')) as {
              entries: { packageName: string; module: string; scopes: string[] }[];
            },
        );
      expect(descriptors, 'First-use sync must produce server facet descriptors.').not.toHaveLength(0);
      expect(
        descriptors.some((descriptor) =>
          descriptor.entries.some(
            (entry) => entry.packageName === '@agimon-ai/doompi-computer-use' && entry.scopes.includes('session'),
          ),
        ),
        'Desktop sync must compose the bundled computer-use facet.',
      ).toBe(true);
      const presentation = launch(hubArguments({ entry, host: LOOPBACK_HOST, port, headlessPort, token }));
      const origin = `http://${LOOPBACK_HOST}:${port}`;
      await ready(presentation, origin);
      const page = await fetch(origin, { headers: { accept: 'text/html' } });
      expect(page.status, output).toBe(200);
      expect(await page.text()).toContain('<html');
      const workspaces = await fetch(`${serverOrigin}/api/workspaces`, { headers: { 'x-doompi-token': token } });
      expect(workspaces.status, output).toBe(200);
      expect(await workspaces.json()).toMatchObject({ workspaces: expect.any(Array) });
      expect(output).not.toContain('Headless selection failed:');
      // Shutdown is asserted while the temp runtime still exists; cleanup is not the assertion.
      await stop(presentation);
      await stop(headless);
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    } finally {
      shutdown = await Promise.allSettled(children.map(stop));
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(
      shutdown.every((result) => result.status === 'fulfilled'),
      'All staged children must exit.',
    ).toBe(true);
  },
  2 * STARTUP_TIMEOUT_MS + 30_000,
);
