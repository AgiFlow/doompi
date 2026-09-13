/**
 * Relative locations the Dev Containers spec looks for a configuration.
 *
 * Ordered as the spec resolves them, so the first hit on disk wins.
 */
export const DEVCONTAINER_CONFIG_PATHS: readonly string[] = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

export const DEVCONTAINER_DISABLED_ENV = 'DOOMPI_SANDBOX_DEVCONTAINER';
export const DEVCONTAINER_CLI_PACKAGE = '@devcontainers/cli@0.80.0';
/** Marks containers this layer brought up, so a stale one can be told apart. */
export const DEVCONTAINER_ID_LABEL = 'doompi.sandbox.devcontainer';

export interface DevcontainerUpResult {
  containerId?: string;
  /** Where the CLI mounted the workspace inside the container. */
  remoteWorkspaceFolder?: string;
  error?: string;
}

export interface DevcontainerUpOptions {
  repoRoot: string;
  /** Host directory holding the broker socket, bind-mounted when one is used. */
  socketDirectory?: string;
  /** Container path the socket directory is mounted at. */
  socketTarget?: string;
}

/** Arguments for bringing the workspace's own dev container up. */
export function devcontainerUpArgs(options: DevcontainerUpOptions): string[] {
  return [
    'up',
    '--workspace-folder',
    options.repoRoot,
    '--log-format',
    'json',
    ...(options.socketDirectory && options.socketTarget
      ? ['--mount', `type=bind,source=${options.socketDirectory},target=${options.socketTarget}`]
      : []),
  ];
}

/**
 * Reads the container id out of the CLI's JSON log stream.
 *
 * The stream carries progress records too, so the result is the last record
 * that reports an outcome rather than the first line parsed.
 */
export function parseDevcontainerUp(stdout: string): DevcontainerUpResult {
  let outcome:
    | { outcome?: string; containerId?: string; remoteWorkspaceFolder?: string; message?: string; description?: string }
    | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && 'outcome' in parsed) {
      outcome = parsed as typeof outcome;
    }
  }
  if (!outcome) return { error: 'The dev container CLI reported no outcome.' };
  if (outcome.outcome !== 'success') {
    return { error: outcome.description || outcome.message || `Dev container start reported ${outcome.outcome}.` };
  }
  if (!outcome.containerId) return { error: 'The dev container started but reported no container id.' };
  return { containerId: outcome.containerId, remoteWorkspaceFolder: outcome.remoteWorkspaceFolder };
}

/**
 * Maps a host path into the dev container's own workspace.
 *
 * A dev container mounts the workspace where its configuration says, commonly
 * /workspaces/<name>, so the host path the launch was given does not exist
 * inside and would fail the exec before the agent ever starts.
 */
export function containerWorkspacePath(repoRoot: string, cwd: string, remoteWorkspaceFolder: string): string {
  const relative = cwd.startsWith(repoRoot) ? cwd.slice(repoRoot.length).replace(/^[\\/]+/, '') : '';
  return relative ? `${remoteWorkspaceFolder}/${relative.split('\\').join('/')}` : remoteWorkspaceFolder;
}

/**
 * Installs the distribution inside a dev container that lacks it.
 *
 * The container is the workspace's own, so it carries the project toolchain
 * rather than this layer's, and nothing guarantees DoomPi is present. `up`
 * reuses an existing container, so this is paid once for its lifetime.
 */
export function bootstrapCommand(version: string): string[] {
  return [
    'sh',
    '-c',
    `command -v doompi >/dev/null 2>&1 && exit 0; ` +
      `command -v npm >/dev/null 2>&1 || { echo "doompi-sandbox: this dev container has no npm to install DoomPi with" >&2; exit 127; }; ` +
      `npm install -g @agimon-ai/doompi@${version} >/dev/null`,
  ];
}

/**
 * Rewrites forwarded host paths into the dev container's workspace.
 *
 * The launcher replays its resolved options, and several carry absolute host
 * paths: --cwd always, plugin and additional directories when set. Those
 * resolve in the built-in image, which mounts the repository at the path it
 * has on the host, but a dev container mounts it wherever its configuration
 * says, and the session would fail looking for a repository that is not there.
 */
export function mapForwardArgs(args: readonly string[], repoRoot: string, remoteWorkspaceFolder: string): string[] {
  return args.map((argument) =>
    argument === repoRoot || argument.startsWith(`${repoRoot}/`)
      ? containerWorkspacePath(repoRoot, argument, remoteWorkspaceFolder)
      : argument,
  );
}

export interface DevcontainerExecOptions {
  containerId: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  hasTty: boolean;
  command: readonly string[];
}

/**
 * Runs a command in the dev container through the engine rather than the CLI.
 *
 * `devcontainer exec` allocates no terminal, which a full screen TUI needs, so
 * the session is attached to the container the CLI already started.
 */
export function devcontainerExecArgs(options: DevcontainerExecOptions): string[] {
  const environmentPairs = Object.entries(options.environment).sort(([left], [right]) => left.localeCompare(right));
  return [
    'exec',
    '-i',
    ...(options.hasTty ? ['-t'] : []),
    '-w',
    options.cwd,
    ...environmentPairs.flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    options.containerId,
    ...options.command,
  ];
}
