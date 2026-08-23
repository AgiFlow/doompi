/**
 * Sandbox harness contract.
 *
 * A layer package that owns sandboxed launches exports a module at the
 * `./sandbox-harness` subpath. The harness resolves that module from the
 * selected composition and delegates the whole launch to it, so core never
 * depends on a concrete sandbox technology.
 */

/** Exports subpath a sandbox-owning layer package declares. */
export const SANDBOX_HARNESS_EXPORT_SUBPATH = './sandbox-harness';

/** Marks a process that already runs inside a DoomPi sandbox. */
export const DOOMPI_SANDBOX_ENV = 'DOOMPI_SANDBOX';

const SANDBOX_FLAG = '1';

/** True inside a sandboxed session, which is how a provider refuses to nest. */
export function insideSandbox(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[DOOMPI_SANDBOX_ENV] === SANDBOX_FLAG;
}

/** One sandboxed launch, owned end to end by the providing layer. */
export interface SandboxLaunchRequest {
  /** Repository the sandbox mounts and works against. */
  repoRoot: string;
  /** Working directory of the launch, expected to sit inside the mounted repository. */
  cwd: string;
  /**
   * Harness arguments the in-sandbox launcher replays. Never contains the
   * sandbox flag itself: a sandboxed launch must not provision another.
   */
  forwardArgs: string[];
  /** Host environment the provider filters before any of it enters the sandbox. */
  environment: NodeJS.ProcessEnv;
  /** Receives one human-readable line per provisioning decision. */
  onProgress?: (message: string) => void;
}

export interface SandboxHarnessModule {
  /** Provisions the sandbox, runs the launch inside it, and reports the exit code. */
  launchSandbox(request: SandboxLaunchRequest): Promise<number>;
}

/** Narrowing guard for a dynamically imported sandbox harness entry. */
export function isSandboxHarnessModule(value: unknown): value is SandboxHarnessModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { launchSandbox?: unknown }).launchSandbox === 'function'
  );
}
