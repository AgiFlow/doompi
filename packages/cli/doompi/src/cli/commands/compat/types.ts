export type CompatibilityProvider = 'antigravity' | 'claude' | 'codex';

export interface CompatibilityOptions {
  repoRoot: string;
  currentDirectory: string;
  provider: CompatibilityProvider;
  /** One persona and its environment defaults from `.doom/profiles.yaml`. */
  profile?: string;
  /** Domain names that select provider plugins and MCP scope. */
  domains: string[];
  /** One named major mode from `.doom/modes.yaml`. */
  majorMode: string;
  /** Arguments passed to the provider without Pi-specific translation. */
  providerArgs: string[];
  /** Directories inherited from the launcher environment. */
  additionalDirectories: string[];
  /**
   * Whether to disable the provider's own approval prompts for this run.
   *
   * Off unless the caller passes `--skip-permissions`. DoomPi scopes which
   * tools and servers load; it does not decide on the user's behalf that the
   * frontend's confirmation gate is unnecessary, so the bypass stays an
   * explicit per-run choice and announces itself on stderr.
   */
  skipPermissions: boolean;
}

export interface ParsedCompatibilityArgs {
  options: Omit<CompatibilityOptions, 'repoRoot' | 'provider'>;
}
