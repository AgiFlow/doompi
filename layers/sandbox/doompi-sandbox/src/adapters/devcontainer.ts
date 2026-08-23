import fs from 'node:fs';
import path from 'node:path';
import {
  bootstrapCommand,
  containerWorkspacePath,
  DEVCONTAINER_CLI_PACKAGE,
  DEVCONTAINER_CONFIG_PATHS,
  devcontainerExecArgs,
  devcontainerUpArgs,
  parseDevcontainerUp,
} from '../services/devcontainer.ts';
import type { EngineProcessRunner, SandboxEngine } from '../types/sandboxHarness.ts';

const DEVCONTAINER_BINARY = 'devcontainer';
const NPX_BINARY = 'npx';
const LAUNCHER_BINARY = 'doompi';
const BROKER_MOUNT_DIRECTORY = '/run/doompi';

/** Locates the workspace's own dev container configuration, if it has one. */
export function findDevcontainerConfig(repoRoot: string): string | undefined {
  for (const relative of DEVCONTAINER_CONFIG_PATHS) {
    const candidate = path.join(repoRoot, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolves how to invoke the Dev Containers CLI.
 *
 * A local install is preferred so a launch does not depend on the network;
 * npx is the fallback, pinned so the tool cannot change underneath a session.
 */
export async function resolveDevcontainerCli(
  runner: EngineProcessRunner,
): Promise<{ command: string; prefix: string[] }> {
  const probe = await runner.capture(DEVCONTAINER_BINARY, ['--version']);
  if (probe?.exitCode === 0) return { command: DEVCONTAINER_BINARY, prefix: [] };
  return { command: NPX_BINARY, prefix: ['-y', DEVCONTAINER_CLI_PACKAGE] };
}

export interface DevcontainerSessionOptions {
  repoRoot: string;
  cwd: string;
  forwardArgs: readonly string[];
  environment: Readonly<Record<string, string>>;
  engine: SandboxEngine;
  runner: EngineProcessRunner;
  version: string;
  hasTty: boolean;
  /** Host directory holding the broker socket, when the broker uses one. */
  socketDirectory?: string;
  onProgress?: (message: string) => void;
}

/**
 * Runs the session inside the workspace's own dev container.
 *
 * The container is brought up by the Dev Containers CLI, so the file decides
 * the image, features, mounts and lifecycle hooks: the session gets the
 * project's real toolchain, and this layer's isolation guarantees do not
 * apply beyond the environment it passes in.
 */
export async function runDevcontainerSession(options: DevcontainerSessionOptions): Promise<number> {
  const cli = await resolveDevcontainerCli(options.runner);
  options.onProgress?.('starting the workspace dev container');

  const upArgs = devcontainerUpArgs({
    repoRoot: options.repoRoot,
    socketDirectory: options.socketDirectory,
    socketTarget: options.socketDirectory ? BROKER_MOUNT_DIRECTORY : undefined,
  });
  const up = await options.runner.capture(cli.command, [...cli.prefix, ...upArgs]);
  if (!up) {
    throw new Error('The Dev Containers CLI could not be started. Install @devcontainers/cli, or make npx available.');
  }
  const { containerId, remoteWorkspaceFolder, error } = parseDevcontainerUp(up.stdout);
  if (!containerId) throw new Error(`The dev container did not start: ${error ?? `exit ${up.exitCode}`}`);

  const bootstrap = await options.runner.run(options.engine, [
    'exec',
    containerId,
    ...bootstrapCommand(options.version),
  ]);
  if (bootstrap !== 0) {
    throw new Error(
      `DoomPi could not be installed in the dev container (exit ${bootstrap}). ` +
        'Add it to the dev container, or unset the dev container preference to use the built-in image.',
    );
  }

  options.onProgress?.(`attaching to dev container ${containerId.slice(0, 12)}`);
  return options.runner.run(
    options.engine,
    devcontainerExecArgs({
      containerId,
      cwd: remoteWorkspaceFolder
        ? containerWorkspacePath(options.repoRoot, options.cwd, remoteWorkspaceFolder)
        : options.cwd,
      environment: options.environment,
      hasTty: options.hasTty,
      command: [LAUNCHER_BINARY, ...options.forwardArgs],
    }),
  );
}
