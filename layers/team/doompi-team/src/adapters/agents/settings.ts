/**
 * Agent settings: reading them, and applying what they say to discovered agents.
 *
 * Two things live here because they are the same contract seen from both ends.
 * Reading turns untyped JSON on disk into settings; applying folds those
 * settings over the agents discovery found. The precedence is fixed: project
 * settings beat user settings, an explicit per-agent override beats a bulk
 * switch, and for a custom agent the agent's own frontmatter beats both.
 *
 * That last rule is why builtins and custom agents take different paths.
 * Overriding a builtin replaces values outright, because a builtin has no file
 * the user could have edited instead. Overriding a custom agent only fills
 * fields its frontmatter left unset, so a settings default never silently
 * contradicts what the author wrote in the file.
 *
 * DESIGN PATTERNS:
 * - Reading is strict and throws with the offending path and field. A settings
 *   file that is quietly half-ignored is worse than one that refuses to load,
 *   because the user sees agents behaving in ways their config does not explain
 * - Applying is pure and copy-on-write. Every `apply*` returns new configs and
 *   never mutates its input, so a cached discovery result cannot be corrupted
 *   by a later pass over it
 * - Overriding a builtin snapshots the values it replaced into `override.base`,
 *   which is what makes removing the override restore the builtin exactly
 *
 * AVOID:
 * - Trusting any shape read off disk without a real guard
 * - Mutating an `AgentConfig` in place
 * - Writing a settings file non-atomically; it holds the user's overrides
 */

import * as fs from 'node:fs';
import { writeAtomicJson } from '../atomicJson';
import { readSettingsFileStrict } from '../filesystem/configDir';
import type { ModelScopeConfig, ToolBudgetConfig } from '../../types';
import { getProjectAgentSettingsPath, getUserAgentSettingsPath } from './projectRoot';

export { readSettingsFileStrict } from '../filesystem/configDir';

import type {
  AgentConfig,
  AgentModelSourceInfo,
  BuiltinAgentOverrideBase,
  BuiltinAgentOverrideConfig,
  SubagentSettings,
} from './types';

const SUBAGENTS_SETTINGS_KEY = 'subagents';
const AGENT_OVERRIDES_KEY = 'agentOverrides';
/** Prefix marking a tool the child calls on an MCP server directly. */
const MCP_DIRECT_TOOL_PREFIX = 'mcp:';

/** Which settings file an override came from, without the value snapshot. */
type OverrideScopeMeta = { scope: 'user' | 'project'; path: string };

/**
 * The snapshot of a builtin's pre-override values.
 *
 * Widens the contract with `mcpDirectTools` because a builtin's tool list is
 * stored split in `AgentConfig` and must round-trip through the snapshot to be
 * restorable. See the report note on `BuiltinAgentOverrideBase`.
 */
export interface BuiltinOverrideSnapshot extends BuiltinAgentOverrideBase {
  mcpDirectTools?: string[];
}

/**
 * Returned whenever there is nothing to read.
 *
 * Shared rather than freshly built per call because it is returned on the hot
 * discovery path for every session with no project settings file.
 */
export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

/**
 * Which fields of a config came from its file's frontmatter.
 *
 * Keyed by the config object rather than by agent name because configs are
 * copied on write: each `apply*` pass produces new objects, and the new one
 * inherits the entry so later passes still know what the author declared.
 * A WeakMap means a discarded config's entry is collectable with it.
 */
const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

/** Record which fields a freshly parsed config took from frontmatter. */
export function setAgentFrontmatterFields(agent: AgentConfig, fields: Set<string>): void {
  agentFrontmatterFields.set(agent, fields);
}

/** True when the agent's file declared any of `fields` in its frontmatter. */
export function agentHasFrontmatterField(agent: AgentConfig, ...fields: string[]): boolean {
  const frontmatterFields = agentFrontmatterFields.get(agent);
  return frontmatterFields ? fields.some((field) => frontmatterFields.has(field)) : false;
}

/** Carry the frontmatter record onto a copy produced by an `apply*` pass. */
function inheritFrontmatterFields(source: AgentConfig, next: AgentConfig): AgentConfig {
  const frontmatterFields = agentFrontmatterFields.get(source);
  if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
  return next;
}

/** Split a flat tool list into host tools and direct MCP tools. */
function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
  const mcpDirectTools: string[] = [];
  const tools: string[] = [];
  for (const tool of rawTools ?? []) {
    if (tool.startsWith(MCP_DIRECT_TOOL_PREFIX)) mcpDirectTools.push(tool.slice(MCP_DIRECT_TOOL_PREFIX.length));
    else tools.push(tool);
  }
  return {
    ...(rawTools !== undefined ? { tools } : {}),
    ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
  };
}

/** Inverse of `splitToolList`, for writing a tool list back to settings. */
function joinToolList(config: { tools?: string[]; mcpDirectTools?: string[] }): string[] | undefined {
  const joined = [
    ...(config.tools ?? []),
    ...(config.mcpDirectTools ?? []).map((tool) => `${MCP_DIRECT_TOOL_PREFIX}${tool}`),
  ];
  return joined.length > 0 ? joined : undefined;
}

/** Order-sensitive equality; a reordered tool list is a real change. */
function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============================================================================
// Reading
// ============================================================================

/**
 * Write a settings file atomically.
 *
 * This file holds every override the user configured. A partial write from a
 * crash mid-save would be read back as malformed on the next start and, because
 * reading is strict, would refuse to load at all.
 */
export function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
  writeAtomicJson(filePath, settings);
}

/** Read a settings object at `key`, or undefined when it is absent or not an object. */
function readObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Copy a settings object at `key`, or start a fresh one when it is absent. */
function cloneObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
  // Spreading undefined is already a no-op, so no empty-object fallback is needed.
  return { ...readObjectField(source, key) };
}

/**
 * Parse the model-scope block.
 *
 * Lives here rather than beside the scope enforcement logic because parsing is
 * a settings concern and the agents domain may not reach into the runs domain.
 */
function parseModelScopeConfig(value: unknown, filePath: string): ModelScopeConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Subagent settings in '${filePath}' have invalid 'modelScope'; expected an object.`);
  }

  const input = value as Record<string, unknown>;
  const config: ModelScopeConfig = {};

  if ('enforce' in input) {
    if (typeof input.enforce !== 'boolean') {
      throw new Error(`Subagent settings in '${filePath}' have invalid 'modelScope.enforce'; expected a boolean.`);
    }
    config.enforce = input.enforce;
  }

  if ('allow' in input) {
    if (!Array.isArray(input.allow)) {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'modelScope.allow'; expected an array of strings.`,
      );
    }
    const allow: string[] = [];
    for (const entry of input.allow) {
      if (typeof entry !== 'string') {
        throw new Error(
          `Subagent settings in '${filePath}' have invalid 'modelScope.allow'; expected an array of strings.`,
        );
      }
      const trimmed = entry.trim();
      if (trimmed) allow.push(trimmed);
    }
    if (allow.length === 0) {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'modelScope.allow'; expected a non-empty array of patterns.`,
      );
    }
    config.allow = allow;
  }

  // Enforcing against an empty allow list would reject every model, so it is
  // rejected here rather than at the point it would start failing runs.
  if (config.enforce === true && (!config.allow || config.allow.length === 0)) {
    throw new Error(
      `Subagent settings in '${filePath}' set modelScope.enforce without a non-empty 'allow' list; supply allowed model patterns or disable enforcement.`,
    );
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Parse a string-array override field, which may also be `false` to clear it.
 *
 * Empty entries are dropped rather than rejected: trailing commas in a hand
 * edited list are common and unambiguous.
 */
export function parseOverrideStringArrayOrFalse(
  value: unknown,
  meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!Array.isArray(value)) {
    throw new Error(
      `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
    );
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(
        `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
      );
    }
    const trimmed = item.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

/**
 * Parse one entry of `subagents.agentOverrides`.
 *
 * Returns undefined for an entry that declared nothing, so an empty object in
 * the file does not register as an override and mark the agent as overridden.
 */
export function parseBuiltinOverrideEntry(
  name: string,
  value: unknown,
  filePath: string,
): BuiltinAgentOverrideConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
  }

  const input = value as Record<string, unknown>;
  const override: BuiltinAgentOverrideConfig = {};

  if ('model' in input) {
    if (typeof input.model === 'string' || input.model === false) override.model = input.model;
    else
      throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
  }

  if ('thinking' in input) {
    if (typeof input.thinking === 'string' || input.thinking === false) override.thinking = input.thinking;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`,
      );
  }

  if ('systemPromptMode' in input) {
    if (input.systemPromptMode === 'append' || input.systemPromptMode === 'replace') {
      override.systemPromptMode = input.systemPromptMode;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`,
      );
    }
  }

  if ('inheritProjectContext' in input) {
    if (typeof input.inheritProjectContext === 'boolean') {
      override.inheritProjectContext = input.inheritProjectContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`,
      );
    }
  }

  if ('inheritSkills' in input) {
    if (typeof input.inheritSkills === 'boolean') {
      override.inheritSkills = input.inheritSkills;
    } else {
      throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
    }
  }

  if ('defaultContext' in input) {
    if (input.defaultContext === 'fresh' || input.defaultContext === 'fork' || input.defaultContext === false) {
      override.defaultContext = input.defaultContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`,
      );
    }
  }

  if ('disabled' in input) {
    if (typeof input.disabled === 'boolean') {
      override.disabled = input.disabled;
    } else {
      throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
    }
  }

  if ('completionGuard' in input) {
    if (typeof input.completionGuard === 'boolean') {
      override.completionGuard = input.completionGuard;
    } else {
      throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`);
    }
  }

  if ('toolBudget' in input) {
    const toolBudget = parseToolBudgetOverride(input.toolBudget, name, filePath);
    if (toolBudget !== undefined) override.toolBudget = toolBudget;
  }

  if ('systemPrompt' in input) {
    if (typeof input.systemPrompt === 'string') override.systemPrompt = input.systemPrompt;
    else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
  }

  const parseArrayField = (field: string): string[] | false | undefined =>
    parseOverrideStringArrayOrFalse(input[field], { filePath, name, field });

  const fallbackModels = parseArrayField('fallbackModels');
  if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;
  const skills = parseArrayField('skills');
  if (skills !== undefined) override.skills = skills;
  const tools = parseArrayField('tools');
  if (tools !== undefined) override.tools = tools;
  const extensions = parseArrayField('extensions');
  if (extensions !== undefined) override.extensions = extensions;
  const subagentOnlyExtensions = parseArrayField('subagentOnlyExtensions');
  if (subagentOnlyExtensions !== undefined) override.subagentOnlyExtensions = subagentOnlyExtensions;

  return Object.keys(override).length > 0 ? override : undefined;
}

/**
 * Parse a `toolBudget` override.
 *
 * `hard` is required by the contract, so an object without a usable one is
 * rejected here instead of producing a budget that never blocks.
 */
function parseToolBudgetOverride(value: unknown, name: string, filePath: string): ToolBudgetConfig | false | undefined {
  if (value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`,
    );
  }

  const input = value as Record<string, unknown>;
  if (typeof input.hard !== 'number') {
    throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolBudget.hard'; expected a number.`);
  }

  const budget: ToolBudgetConfig = { hard: input.hard };
  if ('soft' in input) {
    if (typeof input.soft !== 'number') {
      throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolBudget.soft'; expected a number.`);
    }
    budget.soft = input.soft;
  }
  if ('block' in input) {
    if (input.block === '*') {
      budget.block = '*';
    } else if (Array.isArray(input.block) && input.block.every((entry) => typeof entry === 'string')) {
      budget.block = [...input.block];
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'toolBudget.block'; expected an array of strings or '*'.`,
      );
    }
  }
  return budget;
}

/** Read and validate one settings file's `subagents` block. */
export function readSubagentSettings(filePath: string | null): SubagentSettings {
  if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
  const settings = readSettingsFileStrict(filePath);
  const subagentsObject = readObjectField(settings, SUBAGENTS_SETTINGS_KEY);
  if (!subagentsObject) return EMPTY_SUBAGENT_SETTINGS;

  let disableBuiltins: boolean | undefined;
  if ('disableBuiltins' in subagentsObject) {
    if (typeof subagentsObject.disableBuiltins === 'boolean') {
      disableBuiltins = subagentsObject.disableBuiltins;
    } else {
      throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
    }
  }

  let disableThinking: boolean | undefined;
  if ('disableThinking' in subagentsObject) {
    if (typeof subagentsObject.disableThinking === 'boolean') {
      disableThinking = subagentsObject.disableThinking;
    } else {
      throw new Error(`Subagent settings in '${filePath}' have invalid 'disableThinking'; expected a boolean.`);
    }
  }

  let defaultModel: string | undefined;
  if ('defaultModel' in subagentsObject) {
    if (typeof subagentsObject.defaultModel === 'string' && subagentsObject.defaultModel.trim()) {
      defaultModel = subagentsObject.defaultModel.trim();
    } else {
      throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`);
    }
  }

  let defaultThinking: string | undefined;
  if ('defaultThinking' in subagentsObject) {
    if (typeof subagentsObject.defaultThinking === 'string' && subagentsObject.defaultThinking.trim()) {
      defaultThinking = subagentsObject.defaultThinking.trim();
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'defaultThinking'; expected a non-empty string.`,
      );
    }
  }

  let defaultExtensions: string[] | undefined;
  if ('defaultExtensions' in subagentsObject) {
    const raw = subagentsObject.defaultExtensions;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'defaultExtensions'; expected an array of non-empty strings.`,
      );
    }
    defaultExtensions = raw.map((item) => String(item).trim());
  }

  const modelScope = parseModelScopeConfig(subagentsObject.modelScope, filePath);

  const overrides: Record<string, BuiltinAgentOverrideConfig> = {};
  const agentOverrides = readObjectField(subagentsObject, AGENT_OVERRIDES_KEY);
  if (agentOverrides) {
    for (const [name, value] of Object.entries(agentOverrides)) {
      const override = parseBuiltinOverrideEntry(name, value, filePath);
      if (override) overrides[name] = override;
    }
  }

  return { overrides, defaultModel, defaultThinking, defaultExtensions, disableBuiltins, disableThinking, modelScope };
}

// ============================================================================
// Settings-level defaults
// ============================================================================

/** Which settings file supplies `defaultModel`, project winning over user. */
export function resolveSubagentDefaultModel(
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentModelSourceInfo | undefined {
  if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
    return {
      type: 'subagents.defaultModel',
      scope: 'project',
      path: projectSettingsPath,
      model: projectSettings.defaultModel,
    };
  }
  return userSettings.defaultModel !== undefined
    ? { type: 'subagents.defaultModel', scope: 'user', path: userSettingsPath, model: userSettings.defaultModel }
    : undefined;
}

/**
 * Fill in the default model for agents that declared none.
 *
 * `modelSource` is recorded alongside so callers can tell an inherited model
 * from a requested one, which decides how hard model-scope enforcement bites.
 */
export function applySubagentDefaultModel(
  agents: AgentConfig[],
  defaultModel: AgentModelSourceInfo | undefined,
): AgentConfig[] {
  if (!defaultModel) return agents;
  return agents.map((agent) => {
    if (agent.model !== undefined) return agent;
    return inheritFrontmatterFields(agent, { ...agent, model: defaultModel.model, modelSource: defaultModel });
  });
}

/** Fill in fallback models only when the agent declared no fallback policy. */
export function applySubagentDefaultFallbackModels(
  agents: AgentConfig[],
  fallbackModels: string[] | undefined,
): AgentConfig[] {
  if (fallbackModels === undefined) return agents;
  return agents.map((agent) => {
    if (agent.fallbackModels !== undefined) return agent;
    return inheritFrontmatterFields(agent, { ...agent, fallbackModels: [...fallbackModels] });
  });
}

export function resolveSubagentDefaultThinking(
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  projectSettingsPath: string | null,
): string | undefined {
  if (projectSettingsPath && projectSettings.defaultThinking !== undefined) return projectSettings.defaultThinking;
  return userSettings.defaultThinking;
}

export function applySubagentDefaultThinking(
  agents: AgentConfig[],
  defaultThinking: string | undefined,
): AgentConfig[] {
  if (defaultThinking === undefined) return agents;
  return agents.map((agent) => {
    if (agent.thinking !== undefined) return agent;
    return inheritFrontmatterFields(agent, { ...agent, thinking: defaultThinking });
  });
}

export function resolveSubagentDefaultExtensions(
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  projectSettingsPath: string | null,
): string[] | undefined {
  if (projectSettingsPath && projectSettings.defaultExtensions !== undefined) return projectSettings.defaultExtensions;
  return userSettings.defaultExtensions;
}

/**
 * Fill in default extensions for agents that declared none.
 *
 * The `extensionsFromDefault` flag matters when the agent is later overridden:
 * a snapshot must not record a settings default as if the builtin had declared
 * it, or removing the override would bake the default in permanently.
 */
export function applySubagentDefaultExtensions(
  agents: AgentConfig[],
  defaultExtensions: string[] | undefined,
): AgentConfig[] {
  if (defaultExtensions === undefined) return agents;
  return agents.map((agent) => {
    if (agent.extensions !== undefined) return agent;
    return inheritFrontmatterFields(agent, {
      ...agent,
      extensions: [...defaultExtensions],
      extensionsFromDefault: true,
    });
  });
}

export function applySubagentDefaults(
  agents: AgentConfig[],
  defaultModel: AgentModelSourceInfo | undefined,
  defaultThinking: string | undefined,
  defaultExtensions: string[] | undefined,
  defaultFallbackModels?: string[],
): AgentConfig[] {
  return applySubagentDefaultExtensions(
    applySubagentDefaultThinking(
      applySubagentDefaultFallbackModels(applySubagentDefaultModel(agents, defaultModel), defaultFallbackModels),
      defaultThinking,
    ),
    defaultExtensions,
  );
}

// ============================================================================
// Override snapshots
// ============================================================================

/**
 * Snapshot the fields an override may replace, so it can be undone.
 *
 * `extensions` is omitted when it came from a settings default rather than the
 * agent itself; restoring it would turn a default into a permanent value.
 */
export function cloneOverrideBase(agent: AgentConfig): BuiltinOverrideSnapshot {
  return {
    model: agent.model,
    fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
    thinking: agent.thinking,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    defaultContext: agent.defaultContext,
    disabled: agent.disabled,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills ? [...agent.skills] : undefined,
    skillPath: agent.skillPath ? [...agent.skillPath] : undefined,
    tools: agent.tools ? [...agent.tools] : undefined,
    mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
    extensions: agent.extensionsFromDefault ? undefined : agent.extensions ? [...agent.extensions] : undefined,
    subagentOnlyExtensions: agent.subagentOnlyExtensions ? [...agent.subagentOnlyExtensions] : undefined,
    completionGuard: agent.completionGuard,
    toolBudget: agent.toolBudget,
  };
}

/**
 * Deep-copy an override before it is written to a settings file.
 *
 * Only keys the caller actually set are copied, because an explicit `undefined`
 * would serialise the key away and read back as "not overridden".
 */
export function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
  return {
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.fallbackModels !== undefined
      ? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
      : {}),
    ...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
    ...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
    ...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
    ...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
    ...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
    ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
    ...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
    ...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
    ...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
    ...(override.extensions !== undefined
      ? { extensions: override.extensions === false ? false : [...override.extensions] }
      : {}),
    ...(override.subagentOnlyExtensions !== undefined
      ? {
          subagentOnlyExtensions:
            override.subagentOnlyExtensions === false ? false : [...override.subagentOnlyExtensions],
        }
      : {}),
    ...(override.completionGuard !== undefined ? { completionGuard: override.completionGuard } : {}),
    ...(override.toolBudget !== undefined
      ? {
          toolBudget:
            override.toolBudget === false
              ? false
              : {
                  ...override.toolBudget,
                  ...(Array.isArray(override.toolBudget.block) ? { block: [...override.toolBudget.block] } : {}),
                },
        }
      : {}),
  };
}

// ============================================================================
// Applying overrides
// ============================================================================

/**
 * Replace a builtin's values with an override's.
 *
 * `false` clears a field rather than setting it to false; that distinction is
 * the whole reason the stored shape differs from the snapshot shape.
 */
export function applyBuiltinOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
  meta: OverrideScopeMeta,
): AgentConfig {
  const next: AgentConfig = { ...agent, override: { ...meta, base: cloneOverrideBase(agent) } };

  if (override.model !== undefined) {
    next.model = override.model === false ? undefined : override.model;
    next.modelSource = undefined;
  }
  if (override.fallbackModels !== undefined) {
    next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
  }
  if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
  if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
  if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
  if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
  if (override.defaultContext !== undefined) {
    next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
  }
  if (override.disabled !== undefined) next.disabled = override.disabled;
  if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
  if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
  if (override.tools !== undefined) {
    const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
    next.tools = tools;
    next.mcpDirectTools = mcpDirectTools;
  }
  if (override.extensions !== undefined) {
    next.extensions = override.extensions === false ? undefined : [...override.extensions];
  }
  if (override.subagentOnlyExtensions !== undefined) {
    next.subagentOnlyExtensions =
      override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions];
  }
  if (override.completionGuard !== undefined) next.completionGuard = override.completionGuard;
  if (override.toolBudget !== undefined) {
    next.toolBudget = override.toolBudget === false ? undefined : override.toolBudget;
  }

  return next;
}

/**
 * Strip an agent's thinking level for the bulk `disableThinking` switch.
 *
 * An existing `override` is kept rather than replaced, so a per-agent override
 * remains the recorded reason the agent differs from its builtin definition.
 */
export function clearBuiltinThinking(agent: AgentConfig, meta: OverrideScopeMeta): AgentConfig {
  if (agent.thinking === undefined) return agent;
  return { ...agent, thinking: undefined, override: agent.override ?? { ...meta, base: cloneOverrideBase(agent) } };
}

/**
 * Apply user and project settings to the builtin agents.
 *
 * Precedence per agent: a project override, then the project bulk disable, then
 * a user override, then the user bulk disable. A project file that sets
 * `disableBuiltins` at all (including to false) shadows the user's switch, so a
 * project can re-enable builtins its user settings turned off.
 */
export function applyBuiltinOverrides(
  builtinAgents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentConfig[] {
  const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
  const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;
  const projectThinkingConfigured = projectSettings.disableThinking !== undefined && projectSettingsPath !== null;
  const disableThinking = projectThinkingConfigured
    ? projectSettings.disableThinking === true
    : userSettings.disableThinking === true;
  const disableThinkingMeta: OverrideScopeMeta =
    projectThinkingConfigured && projectSettingsPath
      ? { scope: 'project', path: projectSettingsPath }
      : { scope: 'user', path: userSettingsPath };

  // A per-agent thinking override is more specific than the bulk switch, so it
  // survives it; everything else is cleared.
  const applyGlobalThinking = (agent: AgentConfig, hasExplicitThinkingOverride: boolean): AgentConfig => {
    if (!disableThinking || hasExplicitThinkingOverride) return agent;
    return clearBuiltinThinking(agent, disableThinkingMeta);
  };

  return builtinAgents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, projectOverride, { scope: 'project', path: projectSettingsPath }),
        projectOverride.thinking !== undefined,
      );
    }

    if (projectBulkDisabled && projectSettingsPath) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, { disabled: true }, { scope: 'project', path: projectSettingsPath }),
        false,
      );
    }

    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, userOverride, { scope: 'user', path: userSettingsPath }),
        !projectThinkingConfigured && userOverride.thinking !== undefined,
      );
    }

    if (userBulkDisabled) {
      return applyGlobalThinking(
        applyBuiltinOverride(agent, { disabled: true }, { scope: 'user', path: userSettingsPath }),
        false,
      );
    }

    return applyGlobalThinking(agent, false);
  });
}

/**
 * Apply an override to a custom agent, filling only unset fields.
 *
 * A custom agent has a file the user could have edited, so a settings value
 * must never contradict its frontmatter. Nothing is copied and no `override`
 * is recorded unless at least one field was actually filled, which keeps agents
 * that declared everything from being reported as overridden.
 */
export function applyCustomAgentOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
  meta: OverrideScopeMeta,
): AgentConfig {
  let next: AgentConfig | undefined;
  let anyFilled = false;

  const mutable = (): AgentConfig => {
    next ??= { ...agent };
    return next;
  };

  const fill = <K extends keyof AgentConfig>(field: K, frontmatterFields: string[], value: AgentConfig[K]): void => {
    if (agentHasFrontmatterField(agent, ...frontmatterFields)) return;
    mutable()[field] = value;
    anyFilled = true;
  };

  if (override.model !== undefined && !agentHasFrontmatterField(agent, 'model')) {
    const target = mutable();
    target.model = override.model === false ? undefined : override.model;
    target.modelSource = undefined;
    anyFilled = true;
  }
  if (override.fallbackModels !== undefined) {
    fill(
      'fallbackModels',
      ['fallbackModels'],
      override.fallbackModels === false ? undefined : [...override.fallbackModels],
    );
  }
  if (override.thinking !== undefined) {
    fill('thinking', ['thinking'], override.thinking === false ? undefined : override.thinking);
  }
  if (override.systemPromptMode !== undefined) {
    fill('systemPromptMode', ['systemPromptMode'], override.systemPromptMode);
  }
  if (override.inheritProjectContext !== undefined) {
    fill('inheritProjectContext', ['inheritProjectContext'], override.inheritProjectContext);
  }
  if (override.inheritSkills !== undefined) {
    fill('inheritSkills', ['inheritSkills'], override.inheritSkills);
  }
  if (override.defaultContext !== undefined) {
    fill('defaultContext', ['defaultContext'], override.defaultContext === false ? undefined : override.defaultContext);
  }
  if (override.disabled !== undefined && agent.disabled === undefined) {
    mutable().disabled = override.disabled;
    anyFilled = true;
  }
  if (override.skills !== undefined) {
    fill('skills', ['skill', 'skills'], override.skills === false ? undefined : [...override.skills]);
  }
  if (override.tools !== undefined && !agentHasFrontmatterField(agent, 'tools')) {
    const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
    const target = mutable();
    target.tools = tools;
    target.mcpDirectTools = mcpDirectTools;
    anyFilled = true;
  }
  if (override.extensions !== undefined) {
    fill('extensions', ['extensions'], override.extensions === false ? undefined : [...override.extensions]);
  }
  if (override.subagentOnlyExtensions !== undefined) {
    fill(
      'subagentOnlyExtensions',
      ['subagentOnlyExtensions'],
      override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions],
    );
  }
  if (override.completionGuard !== undefined) {
    fill('completionGuard', ['completionGuard'], override.completionGuard);
  }
  if (override.toolBudget !== undefined) {
    fill('toolBudget', ['toolBudget'], override.toolBudget === false ? undefined : override.toolBudget);
  }

  if (!anyFilled || !next) return agent;
  next.override = { ...meta, base: cloneOverrideBase(agent) };
  return inheritFrontmatterFields(agent, next);
}

export function applyCustomAgentOverrides(
  agents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentConfig[] {
  return agents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
      return applyCustomAgentOverride(agent, projectOverride, { scope: 'project', path: projectSettingsPath });
    }

    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return applyCustomAgentOverride(agent, userOverride, { scope: 'user', path: userSettingsPath });
    }

    return agent;
  });
}

/**
 * Diff an edited agent against its pre-override snapshot.
 *
 * Only changed fields are written, so a settings file records the user's edits
 * rather than a full copy of the builtin that would drift as the builtin does.
 * Returns undefined when nothing changed, which callers treat as "remove the
 * override" rather than "write an empty one".
 */
export function buildBuiltinOverrideConfig(
  base: BuiltinOverrideSnapshot,
  draft: Pick<
    AgentConfig,
    | 'model'
    | 'fallbackModels'
    | 'thinking'
    | 'systemPromptMode'
    | 'inheritProjectContext'
    | 'inheritSkills'
    | 'defaultContext'
    | 'disabled'
    | 'systemPrompt'
    | 'skills'
    | 'tools'
    | 'mcpDirectTools'
    | 'extensions'
    | 'subagentOnlyExtensions'
    | 'completionGuard'
    | 'toolBudget'
  >,
): BuiltinAgentOverrideConfig | undefined {
  const override: BuiltinAgentOverrideConfig = {};

  if (draft.model !== base.model) override.model = draft.model ?? false;
  if (!arraysEqual(draft.fallbackModels, base.fallbackModels)) {
    override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
  }
  if (draft.thinking !== base.thinking) override.thinking = draft.thinking ?? false;
  if (draft.systemPromptMode !== base.systemPromptMode) override.systemPromptMode = draft.systemPromptMode;
  if (draft.inheritProjectContext !== base.inheritProjectContext) {
    override.inheritProjectContext = draft.inheritProjectContext;
  }
  if (draft.inheritSkills !== base.inheritSkills) override.inheritSkills = draft.inheritSkills;
  if (draft.defaultContext !== base.defaultContext) override.defaultContext = draft.defaultContext ?? false;
  if (draft.disabled !== base.disabled) override.disabled = draft.disabled ?? false;
  if (draft.systemPrompt !== base.systemPrompt) override.systemPrompt = draft.systemPrompt;
  if (!arraysEqual(draft.skills, base.skills)) override.skills = draft.skills ? [...draft.skills] : false;

  const baseTools = joinToolList(base);
  const draftTools = joinToolList(draft);
  if (!arraysEqual(draftTools, baseTools)) override.tools = draftTools ? [...draftTools] : false;
  if (!arraysEqual(draft.extensions, base.extensions)) {
    override.extensions = draft.extensions ? [...draft.extensions] : false;
  }
  if (!arraysEqual(draft.subagentOnlyExtensions, base.subagentOnlyExtensions)) {
    override.subagentOnlyExtensions = draft.subagentOnlyExtensions ? [...draft.subagentOnlyExtensions] : false;
  }
  // Compared as booleans because an unset guard and an enabled one behave the
  // same, so only a switch to or from explicitly disabled is a real change.
  if ((draft.completionGuard !== false) !== (base.completionGuard !== false)) {
    override.completionGuard = draft.completionGuard !== false;
  }
  if (JSON.stringify(draft.toolBudget) !== JSON.stringify(base.toolBudget)) {
    override.toolBudget = draft.toolBudget ?? false;
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

// ============================================================================
// Persisting overrides
// ============================================================================

const NO_PROJECT_ROOT_MESSAGE = 'Project override is not available here. No project config root was found.';

/** Resolve the settings file for a scope, or throw when there is no project. */
function requireSettingsPath(cwd: string, scope: 'user' | 'project'): string {
  const filePath = scope === 'project' ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
  if (!filePath) throw new Error(NO_PROJECT_ROOT_MESSAGE);
  return filePath;
}

/** Write an override, replacing any existing entry for the agent wholesale. */
export function saveBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: 'user' | 'project',
  override: BuiltinAgentOverrideConfig,
): string {
  const filePath = requireSettingsPath(cwd, scope);

  const settings = readSettingsFileStrict(filePath);
  const subagents = cloneObjectField(settings, SUBAGENTS_SETTINGS_KEY);
  const agentOverrides = cloneObjectField(subagents, AGENT_OVERRIDES_KEY);

  agentOverrides[name] = cloneOverrideValue(override);
  subagents[AGENT_OVERRIDES_KEY] = agentOverrides;
  settings[SUBAGENTS_SETTINGS_KEY] = subagents;
  writeSettingsFile(filePath, settings);
  return filePath;
}

/**
 * Drop an agent's whole override entry.
 *
 * Emptied containers are deleted rather than left behind, so removing the last
 * override leaves the settings file as it was before any were added.
 */
export function removeBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: 'user' | 'project',
): { path: string; removed: boolean } {
  const filePath = requireSettingsPath(cwd, scope);
  if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

  const settings = readSettingsFileStrict(filePath);
  const subagents = readObjectField(settings, SUBAGENTS_SETTINGS_KEY);
  if (!subagents) return { path: filePath, removed: false };
  const agentOverrides = readObjectField(subagents, AGENT_OVERRIDES_KEY);
  if (!agentOverrides) return { path: filePath, removed: false };
  if (!Object.hasOwn(agentOverrides, name)) return { path: filePath, removed: false };

  const nextSubagents = { ...subagents };
  const nextOverrides = { ...agentOverrides };
  delete nextOverrides[name];
  if (Object.keys(nextOverrides).length > 0) nextSubagents[AGENT_OVERRIDES_KEY] = nextOverrides;
  else delete nextSubagents[AGENT_OVERRIDES_KEY];

  if (Object.keys(nextSubagents).length > 0) settings[SUBAGENTS_SETTINGS_KEY] = nextSubagents;
  else delete settings[SUBAGENTS_SETTINGS_KEY];

  writeSettingsFile(filePath, settings);
  return { path: filePath, removed: true };
}

/** Merge fields into an agent's existing override, leaving the rest in place. */
export function mergeBuiltinAgentOverride(
  cwd: string,
  name: string,
  scope: 'user' | 'project',
  fields: BuiltinAgentOverrideConfig,
): string {
  const filePath = requireSettingsPath(cwd, scope);

  const settings = readSettingsFileStrict(filePath);
  const subagents = cloneObjectField(settings, SUBAGENTS_SETTINGS_KEY);
  const agentOverrides = cloneObjectField(subagents, AGENT_OVERRIDES_KEY);

  const existing = readObjectField(agentOverrides, name) ?? {};
  agentOverrides[name] = { ...existing, ...cloneOverrideValue(fields) };
  subagents[AGENT_OVERRIDES_KEY] = agentOverrides;
  settings[SUBAGENTS_SETTINGS_KEY] = subagents;
  writeSettingsFile(filePath, settings);
  return filePath;
}

/** Remove named fields from an agent's override, dropping it once empty. */
export function removeBuiltinAgentOverrideFields(
  cwd: string,
  name: string,
  scope: 'user' | 'project',
  fields: string[],
): { path: string; removed: boolean } {
  const filePath = requireSettingsPath(cwd, scope);
  if (!fs.existsSync(filePath)) return { path: filePath, removed: false };

  const settings = readSettingsFileStrict(filePath);
  const subagents = readObjectField(settings, SUBAGENTS_SETTINGS_KEY);
  if (!subagents) return { path: filePath, removed: false };
  const agentOverrides = readObjectField(subagents, AGENT_OVERRIDES_KEY);
  if (!agentOverrides) return { path: filePath, removed: false };
  const entry = readObjectField(agentOverrides, name);
  if (!entry) return { path: filePath, removed: false };

  const nextEntry: Record<string, unknown> = { ...entry };
  let removed = false;
  for (const field of fields) {
    if (Object.hasOwn(nextEntry, field)) {
      delete nextEntry[field];
      removed = true;
    }
  }
  if (!removed) return { path: filePath, removed: false };

  const nextSubagents = { ...subagents };
  const nextOverrides = { ...agentOverrides };
  if (Object.keys(nextEntry).length > 0) {
    nextOverrides[name] = nextEntry;
    nextSubagents[AGENT_OVERRIDES_KEY] = nextOverrides;
  } else {
    delete nextOverrides[name];
    if (Object.keys(nextOverrides).length > 0) nextSubagents[AGENT_OVERRIDES_KEY] = nextOverrides;
    else delete nextSubagents[AGENT_OVERRIDES_KEY];
  }
  if (Object.keys(nextSubagents).length > 0) settings[SUBAGENTS_SETTINGS_KEY] = nextSubagents;
  else delete settings[SUBAGENTS_SETTINGS_KEY];

  writeSettingsFile(filePath, settings);
  return { path: filePath, removed: true };
}
