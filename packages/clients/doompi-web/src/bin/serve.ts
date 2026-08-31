#!/usr/bin/env node

import os from 'node:os';
import { createCockpitContainer } from '../adapters/cockpitContainer.ts';
import { handOffRemoteAccess } from '../adapters/cockpitHandoff.ts';
import { hubAnswers, probeHub } from '../adapters/hubProbe.ts';
import { packagedVersion, serveWeb } from '../adapters/httpServer.ts';
import { defaultRemoteStateDir } from '../adapters/remoteAccessStore.ts';
import { relaunchSessions } from '../adapters/sessionRelaunch.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryStore.ts';
import { isLoopbackHost, parseServeOptions } from '../services/serveOptions.ts';
import type { WebServer } from '../types/bridge.ts';
import type { MigratingSession, RemoteAccessSettings } from '../types/remoteAccess.ts';

const ADDRESS_IN_USE = 'EADDRINUSE';
const STOP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 10_000;

function notice(message: string): void {
  process.stderr.write(`[doompi-web] ${message}\n`);
}

/**
 * Signals the running hub and waits for the address to go quiet.
 *
 * Only ever called for a loopback address, because the pid on the other end of
 * the probe is only this machine's pid when the hub is on this machine.
 */
async function stopRunningHub(pid: number, host: string, port: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone, or not ours to signal. The probe below settles it either way.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    if (!(await hubAnswers(host, port))) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const options = parseServeOptions(process.argv.slice(2));
  const url = `http://${options.host}:${String(options.port)}`;
  const stateDir = options.stateDir ?? defaultRemoteStateDir();
  const container = createCockpitContainer({ stateDir, onNotice: notice });
  // A cockpit that was killed rather than closed leaves its container holding
  // the published port, so the next start would fail to bind for a reason
  // nothing explains.
  await container.reapStale();

  // Binding off loopback publishes an unauthenticated cockpit to whoever can
  // reach the address. Remote access exists so nobody has to do this; a warning
  // rather than a refusal, because an existing setup should not break today.
  if (!isLoopbackHost(options.host)) {
    notice(`WARNING: --host ${options.host} is not loopback, so the cockpit is reachable without pairing.`);
    notice('WARNING: turn on remote access in settings instead, which requires a paired device.');
  }

  // One hub serves every session, so a second start is normally a request to
  // use the running one. A second start from a *different* version is not: a
  // long-lived hub signs its asset directory once, so handing back to it would
  // serve the older cockpit for as long as it lives, and a browser that already
  // verified that bundle would never be offered a newer one.
  const running = await probeHub(options.host, options.port);
  if (running !== undefined) {
    const mine = packagedVersion();
    const theirs = running.version ?? 'an older build';
    if (running.version === mine) {
      notice(`cockpit already running at ${url}`);
      return;
    }
    if (running.sessions > 0) {
      notice(`WARNING: ${theirs} is already running at ${url} with ${String(running.sessions)} live session(s).`);
      notice(`WARNING: stop it and run again to serve ${mine}; refusing to interrupt running work.`);
      return;
    }
    if (running.pid === undefined || !isLoopbackHost(options.host)) {
      notice(`WARNING: ${theirs} is already running at ${url} and cannot be replaced automatically.`);
      notice(`WARNING: stop it and run again to serve ${mine}.`);
      return;
    }
    notice(`replacing ${theirs} at ${url} with ${mine}`);
    if (!(await stopRunningHub(running.pid, options.host, options.port))) {
      notice(`WARNING: the hub at ${url} did not stop; serve ${mine} on another port with --port.`);
      return;
    }
  }

  /**
   * What Ctrl-C stops, which is not the same thing throughout the run.
   *
   * A single indirection rather than swapping signal handlers, so the handover
   * never has to reach for `removeAllListeners` and take out whatever else this
   * process has registered.
   */
  let shutDown: () => Promise<void> = async () => {};

  const start = async (): Promise<WebServer> => {
    const server = await serveWeb({
      port: options.port,
      host: options.host,
      assetsDir: options.assetsDir,
      registryDir: resolveRegistryDir({
        flagValue: options.registryDir,
        envValue: process.env[REGISTRY_DIR_ENV],
        homeDir: os.homedir(),
      }),
      spawnCommand: options.spawnCommand,
      remoteStateDir: stateDir,
      cloudflaredPath: options.cloudflaredPath,
      onNotice: notice,
      // Already deferred past its own response by the route that asked, so by
      // the time this runs the caller has its answer and the server can go.
      onHandover: (handover) => {
        void handOver({
          serving: server,
          restart: start,
          container,
          handover,
          port: options.port,
          host: options.host,
          adopt: (next) => {
            shutDown = next;
          },
        });
      },
    });
    shutDown = async () => {
      await server.close();
    };
    return server;
  };

  try {
    await start();
  } catch (error) {
    // Two cockpits starting together can both find the port free; the loser
    // settles for the winner rather than reporting a clash nobody caused.
    if ((error as NodeJS.ErrnoException).code !== ADDRESS_IN_USE) throw error;
    if (await hubAnswers(options.host, options.port)) {
      notice(`cockpit already running at ${url}`);
      return;
    }
    throw new Error(`Port ${String(options.port)} is taken by something that is not a DoomPi cockpit; pass --port.`);
  }

  const stop = (): void => {
    void shutDown().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Hands this cockpit over to one running in a container.
 *
 * The port has to be free before the container can publish onto it, so the
 * order is: stop serving, start the container, and put the host cockpit back if
 * the container does not come up. Leaving the user with nothing listening would
 * be the worst outcome of the three, which is why the rollback also recreates
 * the sessions that were stopped in preparation for a move that did not happen.
 */
async function handOver(input: {
  serving: WebServer;
  restart: () => Promise<WebServer>;
  container: ReturnType<typeof createCockpitContainer>;
  handover: { settings: RemoteAccessSettings; sessions: readonly MigratingSession[] };
  port: number;
  host: string;
  adopt: (shutDown: () => Promise<void>) => void;
}): Promise<void> {
  await input.serving.close();
  const started = await input.container.start({
    workspaces: input.handover.settings.sandbox.workspaces.map((workspace) => ({ path: workspace })),
    port: input.port,
    onProgress: notice,
  });
  if (!started.ok) {
    notice(`the cockpit could not move into a container: ${started.error}`);
    notice('serving from the host again');
    await input.restart();
    await relaunchSessions({
      port: input.port,
      host: input.host,
      sessions: input.handover.sessions,
      onNotice: notice,
    });
    return;
  }
  input.adopt(async () => {
    await started.container.stop();
  });
  // The container answers its own health probe before `start` resolves, so its
  // hub is already there to take the settings and the sessions.
  await handOffRemoteAccess({ port: input.port, settings: input.handover.settings, onNotice: notice });
  await relaunchSessions({ port: input.port, sessions: input.handover.sessions, onNotice: notice });
  // Nothing else holds this process open now that its server is closed, and a
  // supervisor that exits leaves a container nobody will ever stop.
  notice('supervising the cockpit container; Ctrl-C stops it');
  await started.container.supervise();
}

main().catch((error: unknown) => {
  notice(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
