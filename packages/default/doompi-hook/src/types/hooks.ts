/**
 * The hook document contract and the ports that run it.
 *
 * Every name here is written in Claude Code's vocabulary, because that is what
 * `.doom/hooks.yaml` and plugin `hooks.json` files are authored against. The
 * translation onto Pi's lifecycle happens at the adapter boundary.
 */

/** Registry event names. Each is used twice per dispatch, so drift would be silent. */
export const HOOK_EVENT = {
  sessionStart: 'SessionStart',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  stop: 'Stop',
  sessionEnd: 'SessionEnd',
} as const;

export type HookEventName = (typeof HOOK_EVENT)[keyof typeof HOOK_EVENT];

export interface HookCommand {
  command: string;
  /** Seconds before the hook is terminated. Defaults to DEFAULT_HOOK_TIMEOUT_SECONDS. */
  timeout?: number;
}

/** What one registry row declares for the `pi` frontend. */
export interface RegistryBinding {
  matcher?: string;
  command: string;
  timeout?: number;
  skipInSubagent?: boolean;
  order?: number;
}

/** A registry row plus the group membership used to include or drop it. */
export interface RegistryEntry extends RegistryBinding {
  event: string;
  order: number;
  /** Declaration order across every source, used as the sort tiebreaker. */
  position: number;
  groupId: string;
  core: boolean;
  /** Root of the config that declared the group, exported as CLAUDE_PLUGIN_ROOT. */
  baseDirectory: string;
}

export interface RegistryGroup {
  core?: boolean;
  hooks?: Array<{ event: string; pi?: RegistryBinding }>;
}

export interface RegistryDocument {
  groups?: Record<string, RegistryGroup>;
}

/** One `.doom/hooks.yaml` as read from disk, before it is parsed. */
export interface HookDocumentSource {
  baseDirectory: string;
  text: string;
}

/** One `.doom/hooks.yaml` after parsing, tagged with the root that declared it. */
export interface ParsedRegistrySource {
  baseDirectory: string;
  document: RegistryDocument;
}

export interface PluginHookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface PluginHookConfig {
  hooks?: Record<string, PluginHookGroup[]>;
}

/** A parsed plugin config plus the root exported to its commands. */
export interface PluginHookDocument {
  pluginRoot: string;
  config: PluginHookConfig;
}

/** A hook command paired with the config root it runs against. */
export interface ResolvedHook {
  hook: HookCommand;
  root: string;
}

/** The JSON a hook may write on stdout to steer or block the call it observed. */
export interface HookDecision {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    reason?: string;
    additionalContext?: string;
  };
}

export type HookFailureReason =
  | 'spawn_failed'
  | 'non_zero_exit'
  | 'timeout'
  | 'invalid_json'
  | 'registry_read'
  | 'plugin_config';

export interface HookFailure {
  command: string;
  message: string;
  reason: HookFailureReason;
}

export interface HookOutcome {
  decision?: HookDecision;
  failure?: HookFailure;
}

/**
 * The tool fields a payload is built from, named without importing Pi.
 *
 * Pi's ToolCallEvent and ToolResultEvent both satisfy this structurally, so the
 * adapter forwards them unchanged and the payload builder stays host-neutral.
 */
export interface HookToolEvent {
  readonly type: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
}

/** The JSON document handed to a hook on stdin. */
export type HookPayload = Record<string, unknown>;

export interface HookRunOptions {
  repoRoot: string;
  /** Exported as CLAUDE_PLUGIN_ROOT so a hook can reach its own scripts. */
  pluginRoot?: string;
}

/** Runs one hook command and reports what it decided or how it failed. */
export interface HookRunner {
  run(hook: HookCommand, payload: HookPayload, options: HookRunOptions): Promise<HookOutcome>;
}

/** Registry rows for this repository, or the failure that emptied them. */
export interface RegistryRead {
  entries: RegistryEntry[];
  failure?: HookFailure;
}

/** Plugin configs that could be read, and one failure per config that could not. */
export interface PluginDocumentRead {
  documents: PluginHookDocument[];
  failures: HookFailure[];
}

/** Where a plugin declares its hooks. Mirrors the harness state entry. */
export interface PluginHookSourceRef {
  readonly pluginRoot: string;
  readonly configPath: string;
}

/** Reads the hook documents a session runs from. */
export interface HookDocumentReader {
  registry(repoRoot: string): Promise<RegistryRead>;
  plugins(sources: readonly PluginHookSourceRef[]): Promise<PluginDocumentRead>;
}
