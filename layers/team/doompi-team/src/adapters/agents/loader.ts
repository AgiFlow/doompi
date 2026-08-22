/**
 * Reading agent definitions off disk into `AgentConfig` values.
 *
 * One markdown file is one agent: YAML frontmatter declares how the child run
 * should be shaped, and the body is its system prompt. This module owns the walk
 * that finds those files and the field-by-field interpretation of what it finds.
 * Precedence between sources, settings defaults, and builtin overrides are
 * applied by discovery afterwards, never here.
 *
 * DESIGN PATTERNS:
 * - A malformed value fails loudly, a malformed file is skipped quietly. A file
 *   missing `name` or `description` is simply not an agent and must not stop the
 *   sweep, but a `timeoutMs` of "soon" is an authoring mistake that has to
 *   surface rather than be silently dropped
 * - Frontmatter keys this module does not interpret are copied into
 *   `extraFields` verbatim, so a later writer can round-trip a file it did not
 *   fully understand
 * - The directory walk prunes at project boundaries, so an agent directory that
 *   happens to contain a checked-out sub-repository does not absorb its agents
 *
 * ASYNC-ONLY:
 * This package has no synchronous run mode, so the `async` frontmatter field is
 * not interpreted. It falls through into `extraFields` like any other key,
 * which keeps a definition written for the predecessor readable here.
 *
 * AVOID:
 * - Applying settings defaults or builtin overrides in this module
 * - Adding a field here without adding it to `LOADER_KNOWN_FIELDS`, which would
 *   leak it into `extraFields` and get it written back twice
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProjectConfigDir } from '../filesystem/configDir';
import type { SystemPromptMode, ToolBudgetConfig } from '../../types';
import { parseFrontmatter, parseFrontmatterList } from './frontmatter';
import { parseMemoryFrontmatter } from './memory';
import { setAgentFrontmatterFields } from './settings';
import type { AgentConfig, AgentDefaultContext, AgentSource } from './types';

// ============================================================================
// Builtin defaults
// ============================================================================

/**
 * The agents this package ships.
 *
 * Named here because a definition on disk with one of these names is an
 * override of a builtin rather than a new agent, and because their defaults
 * differ from a custom agent's.
 */
export const BUILTIN_AGENT_NAMES = [
  'advisor',
  'context-builder',
  'delegate',
  'oracle',
  'planner',
  'researcher',
  'reviewer',
  'scout',
  'worker',
] as const;

/**
 * The one builtin that extends the host's context instead of replacing it.
 *
 * `delegate` exists to carry out work on the operator's behalf in the same
 * project, so it inherits the host system prompt and project context. Every
 * other agent starts clean, which is what makes its output reproducible.
 */
const CONTEXT_INHERITING_BUILTIN = 'delegate';

export function defaultSystemPromptMode(name: string): SystemPromptMode {
  return name === CONTEXT_INHERITING_BUILTIN ? 'append' : 'replace';
}

export function defaultInheritProjectContext(name: string): boolean {
  return name === CONTEXT_INHERITING_BUILTIN;
}

export function defaultInheritSkills(): boolean {
  return false;
}

// ============================================================================
// Frontmatter vocabulary
// ============================================================================

/**
 * Every frontmatter key this module interprets.
 *
 * Anything absent from this set is preserved in `extraFields` instead. `async`
 * is deliberately absent: this package is async-only, so the key is data to
 * carry, not a setting to honour.
 */
export const LOADER_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'package',
  'description',
  'tools',
  'model',
  'fallbackModels',
  'thinking',
  'systemPromptMode',
  'inheritProjectContext',
  'inheritSkills',
  'defaultContext',
  'timeoutMs',
  'skill',
  'skills',
  'skillPath',
  'extensions',
  'subagentOnlyExtensions',
  'output',
  'defaultReads',
  'defaultProgress',
  'interactive',
  'maxSubagentDepth',
  'completionGuard',
  'toolBudget',
  'memory',
]);

const TRUE_LITERAL = 'true';
const FALSE_LITERAL = 'false';

/** Frontmatter carries strings, so a boolean field is a tri-state until parsed. */
function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === TRUE_LITERAL) return true;
  if (raw === FALSE_LITERAL) return false;
  return undefined;
}

// ============================================================================
// Identity
// ============================================================================

/** A package-qualified agent name: dot-separated lowercase segments. */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const PACKAGE_NAME_SEPARATOR = '.';

/**
 * Reduce an authored package name to the canonical form used in runtime names.
 *
 * Sanitizing rather than rejecting outright keeps a human-written `My Tools`
 * usable, while the pattern check afterwards still rejects anything that
 * sanitizes down to nothing meaningful.
 */
function normalizePackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/(?:^[-.]+|[-.]+$)/g, '');
}

/** Validate a `package` frontmatter value. An absent or empty value is not an error. */
export function parsePackageName(value: unknown, label = 'package'): { packageName?: string; error?: string } {
  if (value === undefined || value === false || value === '') return { packageName: undefined };
  if (typeof value !== 'string') return { error: `${label} must be a string or false when provided.` };
  const packageName = normalizePackageName(value);
  if (!packageName || !IDENTIFIER_PATTERN.test(packageName)) {
    return { error: `${label} is invalid after sanitization.` };
  }
  return { packageName };
}

/** The name an agent is addressed by, qualified when it belongs to a package. */
export function buildRuntimeName(localName: string, packageName?: string): string {
  const trimmedPackage = packageName?.trim();
  return trimmedPackage ? `${trimmedPackage}${PACKAGE_NAME_SEPARATOR}${localName}` : localName;
}

// ============================================================================
// Tool lists
// ============================================================================

/** Marks a tool that is reached through an MCP server rather than the host. */
const MCP_TOOL_PREFIX = 'mcp:';

/**
 * Split an authored `tools` list into host tools and MCP tools.
 *
 * The two are separate fields on `AgentConfig` because they are enforced by
 * different layers, but a single flat list is what an author wants to write.
 */
export function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
  const mcpDirectTools: string[] = [];
  const tools: string[] = [];
  for (const tool of rawTools ?? []) {
    if (tool.startsWith(MCP_TOOL_PREFIX)) {
      mcpDirectTools.push(tool.slice(MCP_TOOL_PREFIX.length));
    } else {
      tools.push(tool);
    }
  }
  return {
    // An empty `tools:` means "no tools", which is not the same as an absent key.
    ...(rawTools !== undefined ? { tools } : {}),
    ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
  };
}

// ============================================================================
// Directory walk
// ============================================================================

const DISCOVERY_PRUNED_DIR_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);
const GIT_DIR_NAME = '.git';
const LEGACY_AGENTS_DIR_NAME = '.agents';
const LEGACY_SKILLS_DIR_NAME = 'skills';
const AGENT_FILE_EXTENSION = '.md';
const CHAIN_FILE_EXTENSION = '.chain.md';

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    // A missing or unreadable path is simply not a directory for our purposes.
    return false;
  }
}

/** A directory that owns its own agent configuration is a separate project. */
function isDiscoveryNestedProjectRoot(dir: string): boolean {
  return isDirectory(getProjectConfigDir(dir)) || isDirectory(path.join(dir, LEGACY_AGENTS_DIR_NAME));
}

/**
 * Decide whether the walk should skip a subdirectory.
 *
 * A nested repository or nested project root is pruned because its agents
 * belong to that project, not to the one being scanned. The root itself is
 * exempt: scanning a project's own agent directory must not prune it.
 */
function shouldPruneDiscoveryDir(rootDir: string, dir: string, dirName: string): boolean {
  if (DISCOVERY_PRUNED_DIR_NAMES.has(dirName)) return true;
  if (fs.existsSync(path.join(dir, GIT_DIR_NAME))) return true;
  return path.resolve(dir) !== path.resolve(rootDir) && isDiscoveryNestedProjectRoot(dir);
}

/**
 * Collect matching files under `dir`, sorted so discovery order is stable.
 *
 * Symlinked entries are followed as files, because staging an agent by symlink
 * is a supported way to share one definition across projects.
 */
export function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean, rootDir = dir): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // An unreadable directory yields nothing rather than failing the whole sweep.
    return files;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldPruneDiscoveryDir(rootDir, filePath, entry.name)) {
        files.push(...listFilesRecursive(filePath, predicate, rootDir));
      }
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!predicate(entry.name)) continue;
    files.push(filePath);
  }
  return files;
}

/**
 * Recognise a file that lives under a legacy `.agents/skills/` directory.
 *
 * Those markdown files are skill documents, not agent definitions, and they
 * predate the split. They would otherwise be loaded as nameless agents.
 */
function isLegacyAgentSkillPath(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  if (path.basename(rootDir).toLowerCase() === LEGACY_AGENTS_DIR_NAME) {
    parts.unshift(LEGACY_AGENTS_DIR_NAME);
  }
  return parts.some((part, index) => part === LEGACY_AGENTS_DIR_NAME && parts[index + 1] === LEGACY_SKILLS_DIR_NAME);
}

// ============================================================================
// Structured field parsing
// ============================================================================

function parseSystemPromptMode(raw: string | undefined, localName: string): SystemPromptMode {
  if (raw === 'replace' || raw === 'append') return raw;
  return defaultSystemPromptMode(localName);
}

function parseDefaultContext(raw: string | undefined): AgentDefaultContext | undefined {
  return raw === 'fork' || raw === 'fresh' ? raw : undefined;
}

function parseTimeoutMs(raw: string | undefined, localName: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Agent '${localName}' has invalid timeoutMs frontmatter; expected a positive integer.`);
  }
  return parsed;
}

function parseToolBudget(raw: string | undefined, localName: string): ToolBudgetConfig | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`);
  }
  // Field-level validation lives with the enforcement layer in the runs domain.
  return parsed as ToolBudgetConfig;
}

// ============================================================================
// Loading
// ============================================================================

/** True for an agent definition file, false for a chain or anything else. */
function isAgentFileName(fileName: string): boolean {
  return fileName.endsWith(AGENT_FILE_EXTENSION) && !fileName.endsWith(CHAIN_FILE_EXTENSION);
}

/**
 * Load every agent definition under `dir`.
 *
 * The returned configs carry only what the file itself declared. Settings
 * defaults, builtin overrides, and cross-source precedence are the caller's job.
 */
export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  for (const filePath of listFilesRecursive(dir, isAgentFileName)) {
    if (isLegacyAgentSkillPath(dir, filePath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // The file can be removed or replaced mid-sweep; skip it, do not abort.
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    // Without both of these the file is documentation, not an agent.
    if (!frontmatter.name || !frontmatter.description) continue;

    const localName = frontmatter.name;
    const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
    // An unusable package name would produce an unaddressable runtime name.
    if (parsedPackage.error) continue;

    const rawTools = parseFrontmatterList(frontmatter.tools);
    const { tools, mcpDirectTools } = splitToolList(rawTools);
    const skills = parseFrontmatterList(frontmatter.skill || frontmatter.skills);
    const skillPath = parseFrontmatterList(frontmatter.skillPath);
    const fallbackModels = parseFrontmatterList(frontmatter.fallbackModels);
    const defaultReads = parseFrontmatterList(frontmatter.defaultReads);
    const maxSubagentDepth = Number(frontmatter.maxSubagentDepth);

    const extraFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!LOADER_KNOWN_FIELDS.has(key)) extraFields[key] = value;
    }

    const agent: AgentConfig = {
      name: buildRuntimeName(localName, parsedPackage.packageName),
      localName,
      packageName: parsedPackage.packageName,
      description: frontmatter.description,
      tools: rawTools !== undefined ? (tools ?? []) : undefined,
      mcpDirectTools: mcpDirectTools && mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
      model: frontmatter.model,
      fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
      thinking: frontmatter.thinking === FALSE_LITERAL ? false : frontmatter.thinking,
      systemPromptMode: parseSystemPromptMode(frontmatter.systemPromptMode, localName),
      inheritProjectContext:
        parseOptionalBoolean(frontmatter.inheritProjectContext) ?? defaultInheritProjectContext(localName),
      inheritSkills: parseOptionalBoolean(frontmatter.inheritSkills) ?? defaultInheritSkills(),
      defaultContext: parseDefaultContext(frontmatter.defaultContext),
      defaultTimeoutMs: parseTimeoutMs(frontmatter.timeoutMs, localName),
      systemPrompt: body,
      source,
      filePath,
      skills: skills && skills.length > 0 ? skills : undefined,
      skillPath: skillPath && skillPath.length > 0 ? skillPath : undefined,
      extensions: parseFrontmatterList(frontmatter.extensions),
      subagentOnlyExtensions: parseFrontmatterList(frontmatter.subagentOnlyExtensions),
      output: frontmatter.output,
      defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
      defaultProgress: frontmatter.defaultProgress === TRUE_LITERAL,
      interactive: frontmatter.interactive === TRUE_LITERAL,
      maxSubagentDepth: Number.isInteger(maxSubagentDepth) && maxSubagentDepth >= 0 ? maxSubagentDepth : undefined,
      completionGuard: parseOptionalBoolean(frontmatter.completionGuard),
      toolBudget: parseToolBudget(frontmatter.toolBudget, localName),
      memory: parseMemoryFrontmatter(frontmatter.memory),
      extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
    // Record what the file actually declared, so a later settings pass can tell
    // an author's explicit value from one this loader defaulted in.
    setAgentFrontmatterFields(agent, new Set(Object.keys(frontmatter)));
    agents.push(agent);
  }

  return agents;
}

// ============================================================================
// Plugin directories
// ============================================================================

/** Path-delimited list of read-only agent directories staged by the host. */
export const EXTRA_AGENT_DIRS_ENV = 'PI_SUBAGENT_EXTRA_AGENT_DIRS';

/**
 * Read-only agent directories contributed by plugins.
 *
 * Read from the environment on every call rather than captured once, because a
 * host can stage a plugin directory after this module is first imported.
 */
export function pluginAgentDirs(): string[] {
  return (process.env[EXTRA_AGENT_DIRS_ENV] ?? '')
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0);
}
