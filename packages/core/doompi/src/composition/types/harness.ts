export type HarnessPreset = 'default' | 'kimi' | 'ollama';
export type HarnessOutputFormat = 'native' | 'vibe-lint';

export interface HarnessOptions {
  repoRoot: string;
  /** Injected home root for home-scoped generated artifacts. */
  homeDirectory?: string;
  cwd: string;
  /** One persona and its environment defaults from `.doom/profiles.yaml`. */
  profile?: string;
  /** Domain names that select plugins, skills, agents, and MCP scope. */
  domains: string[];
  /** One named major mode from `.doom/modes.yaml`. */
  majorMode: string;
  /** Print the resolved matrix and exit instead of launching Pi. */
  explain: boolean;
  /** Write the resolved MCP config into this directory and exit. */
  emitMcp?: string;
  /**
   * Stage resources here instead of in a temporary directory.
   *
   * Set by `doom-pi sync`, whose output has to survive the process so plain Pi
   * can load it. The caller then owns the directory and its removal.
   */
  resourceDirectory?: string;
  pluginDirectories: string[];
  additionalDirectories: string[];
  preset: HarnessPreset;
  /** Native Pi output or one vibe-lint script-provider response object. */
  outputFormat: HarnessOutputFormat;
  /** Suppress the notification extension for this run. */
  mute: boolean;
  automation: boolean;
  autoStop: boolean;
  /** Run the agent inside the sandbox container provided by the composition. */
  sandbox: boolean;
  allowProtectedWrites: boolean;
  hooks: boolean;
  mcp: boolean;
  agents: boolean;
  piArgs: string[];
}

export interface ParsedHarnessArgs {
  options: Omit<HarnessOptions, 'repoRoot'>;
  help: boolean;
  version: boolean;
}
