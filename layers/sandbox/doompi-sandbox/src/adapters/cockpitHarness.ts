import { execFileSync } from 'node:child_process';
import type {
  CockpitContainerHandle,
  CockpitContainerHarnessModule,
  CockpitContainerRequest,
  CockpitContainerStart,
} from '@agimon-ai/doompi-extension-contracts/cockpit-container';
import { buildCockpitPlan, type CockpitGitIdentity } from '../services/cockpitPlan.ts';
import { parseRunFlags, assertRunFlags } from '../services/runFlags.ts';
import { cockpitDockerfile } from '../services/sandboxImage.ts';
import type { EngineProcessRunner, SandboxEngine } from '../types/sandboxHarness.ts';
import { detectEngine, ensureImage } from './harness.ts';
import { cockpitImageTag } from './sandboxImageTag.ts';
import { SpawnEngineProcessRunner } from './engineProcess.ts';

/**
 * Runs the cockpit itself in a container, detached, holding the hub and every
 * session it goes on to spawn.
 *
 * The interactive harness next door wraps one session and blocks until it
 * exits. This one returns a handle while the container keeps running, which is
 * why it is a separate entry rather than a flag on the other.
 */

const RUN_FLAGS_ENV = 'DOOMPI_SANDBOX_RUN_FLAGS';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
const HUB_ROLE = 'hub';

export interface CockpitHarnessDependencies {
  runner?: EngineProcessRunner;
  version?: string;
  /** Test seam: reports whether the cockpit inside is answering yet. */
  probe?: (port: number) => Promise<boolean>;
  /** Test seam: the host's git identity, which is read from the real config by default. */
  gitIdentity?: () => CockpitGitIdentity | undefined;
  now?: () => number;
}

/**
 * Reads the host's committer identity.
 *
 * Passed into the container as environment rather than by mounting the config,
 * so the agent can commit without any credential crossing the boundary. It
 * cannot push, and that is the intended limit.
 */
function readGitIdentity(): CockpitGitIdentity | undefined {
  const read = (key: string): string | undefined => {
    try {
      const value = execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
      return value === '' ? undefined : value;
    } catch {
      // No git, or no such key. An agent that cannot commit is a smaller
      // problem than a launch that refuses to start.
      return undefined;
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  return name !== undefined && email !== undefined ? { name, email } : undefined;
}

/** Answers whether the hub inside the container is serving yet. */
async function defaultProbe(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
    if (!response.ok) return false;
    return ((await response.json()) as { role?: unknown }).role === HUB_ROLE;
  } catch {
    return false;
  }
}

async function stopContainer(runner: EngineProcessRunner, engine: SandboxEngine, id: string): Promise<boolean> {
  const stopped = await runner.capture(engine, ['stop', id]);
  // Removed explicitly because the run is not --rm: a container that dies on
  // startup has to survive long enough for its logs to be read.
  await runner.capture(engine, ['rm', '-f', id]);
  return stopped?.exitCode === 0;
}

/**
 * Whether the engine still reports this container as running.
 *
 * A removed container makes `inspect` fail rather than print `false`, so a
 * non-zero exit is read the same way: not running.
 */
async function isRunning(runner: EngineProcessRunner, engine: SandboxEngine, id: string): Promise<boolean> {
  const probed = await runner.capture(engine, ['inspect', '-f', '{{.State.Running}}', id]);
  return probed?.exitCode === 0 && probed.stdout.trim() === 'true';
}

export function createCockpitHarness(dependencies: CockpitHarnessDependencies = {}): CockpitContainerHarnessModule {
  const runner = dependencies.runner ?? new SpawnEngineProcessRunner();
  const probe = dependencies.probe ?? defaultProbe;
  const readIdentity = dependencies.gitIdentity ?? readGitIdentity;
  const now = dependencies.now ?? ((): number => Date.now());

  return {
    async startCockpitContainer(request: CockpitContainerRequest): Promise<CockpitContainerStart> {
      if (request.workspaces.length === 0) {
        return { ok: false, error: 'A cockpit container needs at least one workspace to mount.' };
      }
      let engine: SandboxEngine;
      try {
        engine = await detectEngine(runner, request.environment);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const runFlags = parseRunFlags(request.environment[RUN_FLAGS_ENV]);
      try {
        assertRunFlags(runFlags, RUN_FLAGS_ENV);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      request.onProgress?.(`using ${engine}${runFlags.length > 0 ? ` with ${runFlags.join(' ')}` : ''}`);

      const version = dependencies.version ?? '0.0.0';
      let imageTag: string;
      try {
        // Before the tunnel is reported ready, never inside a session spawn:
        // a cold build is minutes and the hub gives a spawning session ten
        // seconds to register.
        imageTag = await ensureImage(runner, engine, version, request.onProgress, {
          tag: cockpitImageTag(version),
          dockerfile: cockpitDockerfile(),
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      const plan = buildCockpitPlan({
        workspaces: request.workspaces,
        port: request.port,
        environment: request.environment,
        engine,
        host: { hasTty: false, platform: process.platform, repoKey: '', version },
        imageTag,
        runFlags,
        ...(readIdentity() === undefined ? {} : { gitIdentity: readIdentity() as CockpitGitIdentity }),
      });

      const started = await runner.capture(engine, plan.runArgs);
      const containerId = started?.stdout.trim().split('\n').pop() ?? '';
      if (started?.exitCode !== 0 || containerId === '') {
        return { ok: false, error: `The cockpit container did not start: ${started?.stdout.trim() ?? 'no output'}` };
      }
      request.onProgress?.('waiting for the cockpit to answer');

      const deadline = now() + READY_TIMEOUT_MS;
      for (;;) {
        if (await probe(request.port)) break;
        if (now() >= deadline) {
          const logs = await runner.capture(engine, ['logs', '--tail', '20', containerId]);
          await stopContainer(runner, engine, containerId);
          return {
            ok: false,
            error:
              `The cockpit did not answer within ${String(READY_TIMEOUT_MS / 1000)}s.\n${logs?.stdout ?? ''}`.trim(),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }

      const handle: CockpitContainerHandle = {
        containerId,
        stop: async () => {
          await stopContainer(runner, engine, containerId);
        },
        alive: async () => await isRunning(runner, engine, containerId),
      };
      return { ok: true, handle };
    },

    async reapCockpitContainer(containerId: string): Promise<boolean> {
      // Named by id rather than searched for, because the caller recorded it
      // before the process that owned it went away.
      for (const engine of ['docker', 'podman', 'nerdctl', 'finch'] as const) {
        const probed = await runner.capture(engine, ['--version']);
        if (probed?.exitCode !== 0) continue;
        return await stopContainer(runner, engine, containerId);
      }
      return false;
    },
  };
}

/** The module-shaped entry a host resolves from the composition. */
export async function startCockpitContainer(request: CockpitContainerRequest): Promise<CockpitContainerStart> {
  return await createCockpitHarness().startCockpitContainer(request);
}

export async function reapCockpitContainer(containerId: string): Promise<boolean> {
  return await createCockpitHarness().reapCockpitContainer(containerId);
}
