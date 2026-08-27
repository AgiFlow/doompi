#!/usr/bin/env node

import os from 'node:os';
import { createCockpitContainer } from '../adapters/cockpitContainer.ts';
import { handOffRemoteAccess } from '../adapters/cockpitHandoff.ts';
import { hubAnswers } from '../adapters/hubProbe.ts';
import { serveWeb } from '../adapters/httpServer.ts';
import { defaultRemoteStateDir } from '../adapters/remoteAccessStore.ts';
import { relaunchSessions } from '../adapters/sessionRelaunch.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryStore.ts';
import { isLoopbackHost, parseServeOptions } from '../services/serveOptions.ts';
import type { WebServer } from '../types/bridge.ts';
import type { MigratingSession, RemoteAccessSettings } from '../types/remoteAccess.ts';

const ADDRESS_IN_USE = 'EADDRINUSE';

function notice(message: string): void {
  process.stderr.write(`[doompi-web] ${message}\n`);
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

  // One hub serves every session, so a second start is a request to use the
  // running one, not an error worth a stack trace.
  if (await hubAnswers(options.host, options.port)) {
    notice(`cockpit already running at ${url}`);
    return;
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
