/**
 * Contracts for the agents domain.
 *
 * An agent is a markdown file whose YAML frontmatter declares how a child run
 * should be shaped: which model, which tools, which skills, what counts as done.
 * Everything here describes that declaration and where it was found.
 *
 * DESIGN PATTERNS:
 * - Imports only root contracts, so this module cannot join an import cycle
 * - Types only; the parsing and discovery live beside it
 *
 * AVOID:
 * - Adding runtime values here
 * - Widening `AgentConfig` with fields only one consumer needs
 */

import type { ModelScopeConfig, SystemPromptMode, ToolBudgetConfig } from '../../types';

/** Which directories a discovery pass should read. */
export type AgentScope = 'user' | 'project' | 'both';

/**
 * Where an agent definition came from.
 *
 * The order matters: a project agent shadows a user agent of the same name,
 * which in turn shadows one staged by a plugin.
 */
export type AgentSource = 'plugin' | 'user' | 'project';

/** Whether a child starts from a clean context or forks the parent's. */
export type AgentDefaultContext = 'fresh' | 'fork';

export type AgentMemoryScope = 'project' | 'user';

export interface AgentMemoryConfig {
  enabled?: boolean;
  scope?: AgentMemoryScope;
  maxEntries?: number;
}

/** Records that a model came from a settings default rather than frontmatter. */
export interface AgentModelSourceInfo {
  type: 'subagents.defaultModel' | 'packages.team.defaultModel';
  scope: 'user' | 'project' | 'package';
  path: string;
  model: string;
}

/**
 * The frontmatter fields a builtin agent's override may restate.
 *
 * Overriding a builtin captures the original values so the override can be
 * removed later and the builtin restored exactly, which is why this is a
 * snapshot rather than a diff.
 */
export interface BuiltinAgentOverrideBase {
  description?: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  skills?: string[];
  skillPath?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  defaultContext?: AgentDefaultContext;
  defaultTimeoutMs?: number;
  /** Which runtime executes this agent. Defaults to the in-process `pi` SDK path. */
  runtime?: string;
  interactive?: boolean;
  maxSubagentDepth?: number;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
  memory?: AgentMemoryConfig;
  systemPrompt?: string;
  disabled?: boolean;
}

/**
 * An override as it is stored in a settings file.
 *
 * Distinct from the snapshot above because a stored override needs a third
 * state: `false` means "clear the builtin's value", which is not the same as
 * omitting the key, which means "leave it alone".
 */
export interface BuiltinAgentOverrideConfig {
  description?: string;
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: string | false;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: AgentDefaultContext | false;
  defaultTimeoutMs?: number | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  skillPath?: string[] | false;
  tools?: string[] | false;
  extensions?: string[] | false;
  subagentOnlyExtensions?: string[] | false;
  output?: string | false;
  defaultReads?: string[] | false;
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number | false;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig | false;
  memory?: AgentMemoryConfig | false;
}

/** Which settings file overrode a builtin, and what it looked like before. */
export interface BuiltinAgentOverrideInfo {
  scope: 'user' | 'project';
  path: string;
  base: BuiltinAgentOverrideBase;
}

/**
 * A fully resolved agent definition.
 *
 * Resolved means frontmatter has been merged with settings defaults and any
 * builtin override, so consumers never re-apply precedence themselves.
 */
export interface AgentConfig {
  name: string;
  /** Unqualified name, when the agent is namespaced by a package. */
  localName?: string;
  packageName?: string;
  description: string;
  tools?: string[];
  mcpDirectTools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  /** Controls Pi ambient skill discovery only; explicit named `skills` remain available. */
  inheritSkills: boolean;
  defaultContext?: AgentDefaultContext;
  defaultTimeoutMs?: number;
  /** Which runtime executes this agent. Defaults to the in-process `pi` SDK path. */
  runtime?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  /** Explicit named skill requirements projected into Pi child prompts. */
  skills?: string[];
  /** Lookup roots for explicit skill names; relative roots resolve from the request cwd. */
  skillPath?: string[];
  extensions?: string[];
  /** True when `extensions` came from a settings default, not from frontmatter. */
  extensionsFromDefault?: boolean;
  subagentOnlyExtensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
  memory?: AgentMemoryConfig;
  disabled?: boolean;
  /** Frontmatter keys this package does not interpret, preserved for round-tripping. */
  extraFields?: Record<string, string>;
  override?: BuiltinAgentOverrideInfo;
  modelSource?: AgentModelSourceInfo;
}

/**
 * Settings that shape discovery, read from the user and project settings files.
 *
 * `overrides` holds the stored form, not the snapshot form: a value read from a
 * settings file can be `false` to mean "clear the builtin's value", which is
 * distinct from omitting the key.
 */
export interface SubagentSettings {
  overrides: Record<string, BuiltinAgentOverrideConfig>;
  defaultModel?: string;
  defaultThinking?: string;
  defaultExtensions?: string[];
  disableBuiltins?: boolean;
  disableThinking?: boolean;
  modelScope?: ModelScopeConfig;
}

/** One discovery pass over the agent directories in scope. */
export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  /** Where a newly created project agent should be written, if there is a project. */
  projectAgentsDir: string | null;
  modelScope?: ModelScopeConfig;
}

/**
 * Discovery of agent definitions.
 *
 * Behind an interface because discovery is cached and invalidated: callers on
 * the completion path must be able to ask on every keystroke without paying for
 * a directory walk, and management actions must be able to invalidate.
 */
export type AgentDiscoveryContract = {
  /** Agents visible from `cwd` for the given scope, cached. */
  discover(cwd: string, scope: AgentScope): AgentDiscoveryResult;
  /** Resolve one agent by name, or undefined when no such agent is visible. */
  find(cwd: string, scope: AgentScope, name: string): AgentConfig | undefined;
  /** Drop cached results. Call after any mutation to an agent file or setting. */
  invalidate(): void;
};
