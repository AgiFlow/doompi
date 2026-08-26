/**
 * The argv and environment handed to a spawned child agent.
 *
 * DESIGN PATTERNS:
 * - `resolvePiLaunchToolPlan` is the single place tool access is decided, and it
 *   is pure. Everything about what a child may call is computable and testable
 *   without touching the filesystem or spawning anything
 * - Capability ceilings only ever narrow. A ceiling from this process is
 *   intersected with the one inherited from our own parent, and every requested
 *   tool is then filtered against the result. Nothing in this file can add a tool
 *   the ceiling excludes
 * - Fan-out authority is derived, not requested. A child receives the parent
 *   event sink, control inbox, capability token and nesting path ONLY if it was
 *   granted the `subagent` tool. Otherwise those variables are set to the empty
 *   string rather than omitted, so an inherited value from our own environment
 *   cannot leak through into a child that is not allowed to fan out
 * - Long task text goes to a private file passed as `@path` instead of argv,
 *   because argv is both length-limited and visible in the process table
 *
 * AVOID:
 * - Widening anything here. If a case is ambiguous, narrow it
 * - Omitting a fan-out variable instead of blanking it; omission inherits
 * - Re-declaring env var names; they live in `src/env.ts` and cross processes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildPromptCacheProjection, sha256Base64Url } from '@agimon-ai/doompi-cache';
import {
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-cache/env';
import {
  DOOM_CHILD_PROCESS_CONTEXT_ENV,
  encodeChildProcessContext,
} from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
  decodeProtectedParentProcessIds,
  DOOMPI_CHILD_EXTENSIONS_ENV,
  DOOMPI_SKILL_DIRS_ENV,
  INHERIT_PROJECT_CONTEXT_ENV,
  INHERIT_SKILLS_ENV,
  MCP_DIRECT_CHILD_TOOLS_ENV,
  MCP_DIRECT_TOOLS_ENV,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  PI_INTERCOM_SESSION_ID_ENV,
  PI_INTERCOM_STABLE_ID_ENV,
  REQUIRED_CHILD_TOOLS_ENV,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  SUBAGENT_CAPABILITY_CEILING_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_PROTECTED_PARENT_PIDS_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_ACK_DIR_ENV,
  SUBAGENT_STEER_CAPABILITY_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  TOOL_BUDGET_ENV,
  TOOL_BUDGET_ZERO_AUTH_ENV,
} from '../../../types/environment';
import {
  decodeSubagentCapabilityCeiling,
  encodeSubagentCapabilityCeiling,
  intersectSubagentCapabilityCeilings,
  type ResolvedSubagentCapabilityCeiling,
  type SubagentCapabilityAudit,
} from '../../../schemas/team/capabilityCeiling';
import { THINKING_LEVELS } from '../../../services/models/modelInfo';
import { currentChildLaunchTempDir } from '../../filesystem/paths';
import type { JsonSchemaObject } from '../../../types';
import {
  clearNativeTeamMemberEnvironment,
  NATIVE_TEAM_TOOL_NAME,
  nativeTeamMemberEnvironment,
  type TeamMemberContext,
} from '../../intercom/nativeTeamChannel';
import {
  type McpDirectToolResolver,
  type ResolvedMcpDirectToolSelection,
  resolveMcpDirectToolSelections,
} from './mcpDirectToolAllowlist';
import { encodeNestedPathEnv, type NestedPathEntry, parseNestedPathEnv } from './nestedPath';
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot, resolvePiPackageRootNearHost } from './piSpawn';
import { encodeToolBudgetEnv, type ResolvedToolBudget } from './toolBudget';

/**
 * Task text longer than this is written to a file and passed as `@path`.
 *
 * Well under the platform argv limit, because the task shares argv with the
 * model, tool and extension flags.
 */
const TASK_ARG_LIMIT = 8000;
const TEMP_DIRECTORY_PREFIX = 'doom-team-launch-';
const TASK_PREFIX = 'Task: ';
const TYPESCRIPT_EXTENSION = '.ts';
const JAVASCRIPT_EXTENSION = '.js';
const PROMPT_FILE_EXTENSION = '.md';
const DEFAULT_PROMPT_FILE_STEM = 'prompt';
const TASK_FILE_NAME = 'task.md';
const TOOL_DIAGNOSTIC_FILE_NAME = 'tool-diagnostic.json';
const READ_TOOL_NAME = 'read';
const MCP_TOOL_NAME = 'mcp';
const ALL_MCP_SERVERS_SELECTOR = '*';
const SUBAGENT_TOOL_NAME = 'subagent';
const STRUCTURED_OUTPUT_TOOL_NAME = 'structured_output';
const NO_MCP_DIRECT_TOOLS = '__none__';
const ENABLED_ENV_VALUE = '1';
const DISABLED_ENV_VALUE = '0';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const ROOT_FANOUT_DEPTH = 1;
const UNSAFE_PROMPT_STEM_CHARACTERS = /[^\w.-]/g;
const DIGITS_ONLY = /^\d+$/;

const SESSION_FLAG = '--session';
const NO_SESSION_FLAG = '--no-session';
const SESSION_DIRECTORY_FLAG = '--session-dir';
const MODEL_FLAG = '--model';
const TOOLS_FLAG = '--tools';
const NO_TOOLS_FLAG = '--no-tools';
const EXCLUDE_TOOLS_FLAG = '--exclude-tools';
const NO_EXTENSIONS_FLAG = '--no-extensions';
const EXTENSION_FLAG = '--extension';
const NO_CONTEXT_FILES_FLAG = '--no-context-files';
const NO_SKILLS_FLAG = '--no-skills';
const SYSTEM_PROMPT_FLAG = '--system-prompt';
const APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt';

const BUILT_OUTPUT_DIR = 'dist';
const SOURCE_DIR = 'src';
const BUILT_EXTENSION = '.mjs';
const PROMPT_RUNTIME_EXTENSION = 'extensions/subagentPromptRuntimeEntry';
const PROMPT_RUNTIME_SOURCE = 'adapters/pi/extensions/subagentPromptRuntimeEntry';
const PROMPT_RUNTIME_SOURCE_EXTENSION = '.cts';
const FANOUT_CHILD_EXTENSION = 'extension/fanout-child';
const CACHE_RUNTIME_EXTENSION = '@agimon-ai/doompi-cache/extensions/pi';

function terminalChildExtensions(extensions: readonly string[]): string[] {
  return [...new Set(extensions.filter((extension) => extension !== CACHE_RUNTIME_EXTENSION)), CACHE_RUNTIME_EXTENSION];
}
/**
 * Locate an extension the child must load, in either a built or a source tree.
 *
 * The child is a separate process loading these by path, so the path has to be
 * the one that exists on disk now: `.mjs` under `dist` when this bundle is
 * built, the original source file when it is not.
 *
 * Resolved on demand rather than at module load. Doing it eagerly would make
 * importing this module throw in any tree where the extensions are not built
 * yet, which turns a launch-time problem into an import-time one.
 */
function resolveRuntimeExtensionPath(
  relativePath: string,
  sourceExtension = TYPESCRIPT_EXTENSION,
  sourceRelativePath = relativePath,
): string {
  const modulePath = fileURLToPath(import.meta.url);
  const builtMode = modulePath.split(path.sep).includes(BUILT_OUTPUT_DIR);
  const runtimeRoot = builtMode ? BUILT_OUTPUT_DIR : SOURCE_DIR;
  const extension = builtMode ? BUILT_EXTENSION : sourceExtension;
  const resolvedRelativePath = builtMode ? relativePath : sourceRelativePath;
  let directory = path.dirname(modulePath);
  while (true) {
    const candidate = path.join(directory, runtimeRoot, `${resolvedRelativePath}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not resolve runtime extension ${relativePath}`);
    directory = parent;
  }
}

export interface BuildPiArgsInput {
  parentSessionId?: string;
  baseArgs: string[];
  task: string;
  sessionEnabled: boolean;
  sessionDir?: string;
  sessionFile?: string;
  model?: string;
  thinking?: string | false;
  systemPromptMode?: 'append' | 'replace';
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  requireReadTool?: boolean;
  tools?: string[];
  excludeTools?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  systemPrompt?: string | null;
  mcpDirectTools?: string[];
  mcpToolResolver?: McpDirectToolResolver;
  cwd?: string;
  promptFileStem?: string;
  intercomSessionName?: string;
  runId?: string;
  childAgentName?: string;
  childIndex?: number;
  parentEventSink?: string;
  parentControlInbox?: string;
  parentRootRunId?: string;
  parentRunId?: string;
  parentChildIndex?: number;
  parentDepth?: number;
  parentPath?: NestedPathEntry[];
  parentCapabilityToken?: string;
  steerInboxDir?: string;
  steerCapabilityPath?: string;
  steerAckDir?: string;
  structuredOutput?: {
    schema: JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
  };
  toolBudget?: ResolvedToolBudget;
  allowZeroToolBudget?: boolean;
  capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
  teamMember?: TeamMemberContext;
  teamToolEnabled?: boolean;
}

export interface BuildPiArgsResult {
  args: string[];
  env: Record<string, string | undefined>;
  sdk: PiSdkLaunchSettings;
  tempDir?: string;
  toolDiagnosticPath?: string;
  capabilityAudit?: SubagentCapabilityAudit;
}

export interface PiSdkLaunchSettings {
  model?: string;
  tools?: string[];
  noTools?: 'all';
  excludeTools?: string[];
  extensions: string[];
  extensionsProvidedExternally?: boolean;
  noAmbientExtensions: boolean;
  skillPaths: string[];
  noSkills: boolean;
  noContextFiles: boolean;
  sessionEnabled: boolean;
  sessionDir?: string;
  sessionFile?: string;
  systemPrompt?: string;
  systemPromptMode?: 'append' | 'replace';
}

function inheritedDoomPiExtensions(environment: NodeJS.ProcessEnv = process.env): string[] {
  const raw = environment[DOOMPI_CHILD_EXTENSIONS_ENV];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`${DOOMPI_CHILD_EXTENSIONS_ENV} must be valid JSON.${detail}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`${DOOMPI_CHILD_EXTENSIONS_ENV} must be a JSON array of extension paths.`);
  }
  return parsed;
}

function inheritedDoomPiSkillPaths(environment: NodeJS.ProcessEnv = process.env): string[] {
  const raw = environment[DOOMPI_SKILL_DIRS_ENV];
  return raw ? raw.split(path.delimiter).filter(Boolean) : [];
}

/**
 * Append a thinking level to a model id.
 *
 * A model id that already carries a known level is left alone unless the caller
 * asks to replace it, so an explicit per-agent choice survives an inherited one.
 */
export function applyThinkingSuffix(
  model: string | undefined,
  thinking: string | false | undefined,
  replaceExisting = false,
): string | undefined {
  if (!model || !thinking) return model;
  const colonIdx = model.lastIndexOf(':');
  if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) {
    return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
  }
  return `${model}:${thinking}`;
}

export interface ResolvePiLaunchToolPlanInput {
  tools?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  mcpDirectTools?: string[];
  mcpToolResolver?: McpDirectToolResolver;
  cwd?: string;
  requireReadTool?: boolean;
  excludeTools?: string[];
  structuredOutput?: boolean;
  teamToolEnabled?: boolean;
  capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
  inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface PiLaunchToolPlan {
  capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
  excludedTools: string[];
  requestedBuiltinTools: string[];
  declaredBuiltinTools: string[];
  toolExtensionPaths: string[];
  resolvedMcpSelections: ResolvedMcpDirectToolSelection[];
  effectiveMcpSelections: ResolvedMcpDirectToolSelection[];
  effectiveMcpTools: string[];
  explicitToolAllowlist: boolean;
  internalTools: string[];
  effectiveToolAllowlist: string[];
  requiredChildTools: string[];
  fanoutAuthorized: boolean;
  runtimeExtensions: string[];
  configuredExtensions: string[];
  extensionArgs: string[];
  disableAmbientExtensions: boolean;
  capabilityAudit?: SubagentCapabilityAudit;
}

export interface ResolvePiSdkResourcePlanInput extends ResolvePiLaunchToolPlanInput {
  inheritSkills: boolean;
  environment?: NodeJS.ProcessEnv;
}

/** The resource-only subset of Pi SDK settings, safe to calculate without writing launch files. */
export interface PiSdkResourcePlan {
  toolPlan: PiLaunchToolPlan;
  tools?: string[];
  noTools?: 'all';
  excludeTools?: string[];
  extensions: string[];
  extensionsProvidedExternally: boolean;
  noAmbientExtensions: boolean;
  skillPaths: string[];
  noSkills: boolean;
}

/** A tool entry is an extension path, not a builtin name, when it looks like a path. */
function isToolExtensionPath(tool: string): boolean {
  return tool.includes('/') || tool.endsWith(TYPESCRIPT_EXTENSION) || tool.endsWith(JAVASCRIPT_EXTENSION);
}

/**
 * Decide exactly what the child may call.
 *
 * This is the security boundary. The order matters: the ceiling is computed
 * first, and every later step filters against it. `requireReadTool` can add
 * `read` to a nonempty caller request only when no ceiling is in force. A
 * ceiling or explicit effective allowlist that omits `read` is refused rather
 * than widened.
 */
export function resolvePiLaunchToolPlan(input: ResolvePiLaunchToolPlanInput): PiLaunchToolPlan {
  const capabilityCeiling = intersectSubagentCapabilityCeilings(
    input.capabilityCeiling,
    input.inheritedCapabilityCeiling,
  );
  const allowedToolSet =
    capabilityCeiling?.allowedTools === undefined ? undefined : new Set(capabilityCeiling.allowedTools);
  const allowedBuiltinTools = capabilityCeiling?.allowedTools?.filter(
    (tool) => !(capabilityCeiling.allowMcpTools === true && tool === MCP_TOOL_NAME),
  );
  const excludedTools = [
    ...new Set((input.excludeTools ?? []).map((tool) => tool.trim()).filter((tool) => tool.length > 0)),
  ];
  const excludedToolSet = new Set(excludedTools);
  const policyRequiredTools = capabilityCeiling?.requiredTools ?? [];
  const mcpToolsAllowed = capabilityCeiling?.allowMcpTools === true;
  const mcpRequested = mcpToolsAllowed && [...(input.tools ?? []), ...policyRequiredTools].includes(MCP_TOOL_NAME);
  const requestedBuiltinTools = [...new Set([...(input.tools ?? []), ...policyRequiredTools])].filter(
    (tool) => !isToolExtensionPath(tool) && !(mcpRequested && tool === MCP_TOOL_NAME),
  );
  const requestedMcpSelectors = [...(input.mcpDirectTools ?? []), ...(mcpRequested ? [ALL_MCP_SERVERS_SELECTOR] : [])];
  if (input.requireReadTool && excludedToolSet.has(READ_TOOL_NAME)) {
    throw new Error(`Child tool exclusions exclude required tool '${READ_TOOL_NAME}' for lazy skill loading.`);
  }
  if (input.structuredOutput && excludedToolSet.has(STRUCTURED_OUTPUT_TOOL_NAME)) {
    throw new Error(`Child tool exclusions exclude required tool '${STRUCTURED_OUTPUT_TOOL_NAME}'.`);
  }
  if (input.requireReadTool && allowedToolSet && !allowedToolSet.has(READ_TOOL_NAME)) {
    throw new Error(
      `Capability ceiling from ${capabilityCeiling?.sources.join(', ') || 'unknown source'} excludes required tool '${READ_TOOL_NAME}' for lazy skill loading.`,
    );
  }
  // No `tools` at all means "whatever the host allows", which under a ceiling
  // becomes exactly the ceiling and without one stays unconstrained.
  const declaredBuiltinTools =
    input.tools === undefined
      ? (allowedBuiltinTools ?? [])
      : (input.requireReadTool &&
        requestedBuiltinTools.length > 0 &&
        !requestedBuiltinTools.includes(READ_TOOL_NAME) &&
        !allowedToolSet
          ? [READ_TOOL_NAME, ...requestedBuiltinTools]
          : requestedBuiltinTools
        )
          .filter((tool) => !allowedToolSet || allowedToolSet.has(tool))
          .filter((tool) => !excludedToolSet.has(tool));
  // Fan-out authority is exactly "was granted the subagent tool", read after
  // ceiling filtering so a denied tool cannot confer it.
  const fanoutAuthorized = declaredBuiltinTools.includes(SUBAGENT_TOOL_NAME);
  const toolExtensionPaths: string[] = capabilityCeiling?.denyExtensions
    ? []
    : (input.tools ?? []).filter((tool) => !requestedBuiltinTools.includes(tool) && isToolExtensionPath(tool));
  const resolvedMcpSelections = capabilityCeiling?.denyExtensions
    ? []
    : resolveMcpDirectToolSelections(requestedMcpSelectors, input.mcpToolResolver);
  const effectiveMcpSelections = resolvedMcpSelections.filter(
    (selection) =>
      (mcpToolsAllowed || !allowedToolSet || allowedToolSet.has(selection.name)) &&
      !excludedToolSet.has(selection.name),
  );
  const effectiveMcpTools = effectiveMcpSelections.map((selection) => selection.name);
  const explicitToolAllowlist =
    input.tools !== undefined || requestedMcpSelectors.length > 0 || allowedToolSet !== undefined;
  // Internal tools are ours, not the caller's, so they bypass the allowlist but
  // are still reported in the audit.
  const internalTools = [
    ...(input.structuredOutput ? [STRUCTURED_OUTPUT_TOOL_NAME] : []),
    ...(input.teamToolEnabled ? [NATIVE_TEAM_TOOL_NAME] : []),
  ].filter((tool) => !excludedToolSet.has(tool));
  const effectiveToolAllowlist = [...new Set([...declaredBuiltinTools, ...effectiveMcpTools, ...internalTools])];
  if (input.requireReadTool && explicitToolAllowlist && !effectiveToolAllowlist.includes(READ_TOOL_NAME)) {
    throw new Error(
      `Effective child tool allowlist excludes required tool '${READ_TOOL_NAME}' for lazy skill loading.`,
    );
  }
  const requiredChildTools = explicitToolAllowlist
    ? [
        ...new Set([
          ...(input.tools !== undefined ? declaredBuiltinTools : []),
          ...(requestedMcpSelectors.length ? effectiveMcpTools : []),
          ...internalTools,
        ]),
      ]
    : [];
  const promptRuntimeExtension = resolveRuntimeExtensionPath(
    PROMPT_RUNTIME_EXTENSION,
    PROMPT_RUNTIME_SOURCE_EXTENSION,
    PROMPT_RUNTIME_SOURCE,
  );
  const runtimeExtensions = fanoutAuthorized
    ? [promptRuntimeExtension, resolveRuntimeExtensionPath(FANOUT_CHILD_EXTENSION), CACHE_RUNTIME_EXTENSION]
    : [promptRuntimeExtension, CACHE_RUNTIME_EXTENSION];
  const disableAmbientExtensions = capabilityCeiling?.denyExtensions === true || input.extensions !== undefined;
  const configuredExtensions = capabilityCeiling?.denyExtensions
    ? []
    : [...toolExtensionPaths, ...(input.extensions ?? []), ...(input.subagentOnlyExtensions ?? [])];
  const extensionArgs = terminalChildExtensions(
    disableAmbientExtensions
      ? [...runtimeExtensions, ...configuredExtensions]
      : [...runtimeExtensions, ...toolExtensionPaths, ...(input.subagentOnlyExtensions ?? [])],
  );
  const requestedToolNames =
    input.tools !== undefined
      ? [...new Set([...requestedBuiltinTools, ...resolvedMcpSelections.map((selection) => selection.name)])]
      : undefined;
  const capabilityAudit = capabilityCeiling
    ? ({
        ceiling: capabilityCeiling,
        ...(requestedToolNames ? { requestedTools: requestedToolNames } : {}),
        effectiveTools: effectiveToolAllowlist,
        removedTools: requestedToolNames?.filter((tool) => !effectiveToolAllowlist.includes(tool)) ?? [],
        internalTools,
        extensionsDenied: capabilityCeiling.denyExtensions,
        removedExtensionCount: capabilityCeiling.denyExtensions
          ? (input.extensions?.length ?? 0) +
            (input.subagentOnlyExtensions?.length ?? 0) +
            (input.tools ?? []).filter(isToolExtensionPath).length
          : 0,
        requestedMcpToolCount: requestedMcpSelectors.length,
        effectiveMcpTools,
      } satisfies SubagentCapabilityAudit)
    : undefined;
  return {
    ...(capabilityCeiling ? { capabilityCeiling } : {}),
    excludedTools,
    requestedBuiltinTools,
    declaredBuiltinTools,
    toolExtensionPaths,
    resolvedMcpSelections,
    effectiveMcpSelections,
    effectiveMcpTools,
    explicitToolAllowlist,
    internalTools,
    effectiveToolAllowlist,
    requiredChildTools,
    fanoutAuthorized,
    runtimeExtensions,
    configuredExtensions,
    extensionArgs,
    disableAmbientExtensions,
    ...(capabilityAudit ? { capabilityAudit } : {}),
  };
}

/**
 * Resolve the child SDK's resource settings without creating launch files or
 * starting a child process. Filesystem-backed MCP and runtime-extension lookup
 * still follows the same path as a real launch.
 */
export function resolvePiSdkResourcePlan(input: ResolvePiSdkResourcePlanInput): PiSdkResourcePlan {
  const environment = input.environment ?? process.env;
  const inheritedCapabilityCeiling = intersectSubagentCapabilityCeilings(
    input.inheritedCapabilityCeiling,
    decodeSubagentCapabilityCeiling(environment[SUBAGENT_CAPABILITY_CEILING_ENV]),
  );
  const toolPlan = resolvePiLaunchToolPlan({
    tools: input.tools,
    extensions: input.extensions,
    subagentOnlyExtensions: input.subagentOnlyExtensions,
    mcpDirectTools: input.mcpDirectTools,
    mcpToolResolver: input.mcpToolResolver,
    cwd: input.cwd,
    requireReadTool: input.requireReadTool,
    excludeTools: input.excludeTools,
    structuredOutput: input.structuredOutput,
    teamToolEnabled: input.teamToolEnabled,
    capabilityCeiling: input.capabilityCeiling,
    inheritedCapabilityCeiling,
  });
  const explicitTools = toolPlan.explicitToolAllowlist ? toolPlan.effectiveToolAllowlist : undefined;
  const inheritedExtensions = inheritedDoomPiExtensions(environment);
  return {
    toolPlan,
    ...(explicitTools && explicitTools.length > 0 ? { tools: explicitTools } : {}),
    ...(explicitTools?.length === 0 ? { noTools: 'all' as const } : {}),
    ...(toolPlan.excludedTools.length > 0 ? { excludeTools: toolPlan.excludedTools } : {}),
    extensions: terminalChildExtensions([...inheritedExtensions, ...toolPlan.extensionArgs]),
    extensionsProvidedExternally: Boolean(environment[DOOMPI_CHILD_EXTENSIONS_ENV]?.trim()),
    noAmbientExtensions: toolPlan.disableAmbientExtensions,
    skillPaths: input.inheritSkills ? inheritedDoomPiSkillPaths(environment) : [],
    noSkills: !input.inheritSkills,
  };
}

/**
 * Scratch directory for this launch's prompt, task and diagnostics.
 *
 * Created 0700 under the per-user temp root, because the files inside carry the
 * full task and system prompt.
 */
function createLaunchTempDir(): string {
  fs.mkdirSync(currentChildLaunchTempDir(), { recursive: true, mode: PRIVATE_DIR_MODE });
  return fs.mkdtempSync(path.join(currentChildLaunchTempDir(), TEMP_DIRECTORY_PREFIX));
}

/** `resolveInstalledPiPackageRoot` throws when the SDK exists only as an in-process alias; here that is just "no root". */
function installedPiPackageRootOrUndefined(): string | undefined {
  try {
    return resolveInstalledPiPackageRoot();
  } catch {
    return undefined;
  }
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
  const args = [...input.baseArgs];

  if (input.sessionFile) {
    fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
    args.push(SESSION_FLAG, input.sessionFile);
  } else {
    if (!input.sessionEnabled) {
      args.push(NO_SESSION_FLAG);
    }
    if (input.sessionDir) {
      fs.mkdirSync(input.sessionDir, { recursive: true });
      args.push(SESSION_DIRECTORY_FLAG, input.sessionDir);
    }
  }

  const modelArg = applyThinkingSuffix(input.model, input.thinking);
  if (modelArg) {
    args.push(MODEL_FLAG, modelArg);
  }

  const resourcePlan = resolvePiSdkResourcePlan({
    tools: input.tools,
    extensions: input.extensions,
    subagentOnlyExtensions: input.subagentOnlyExtensions,
    mcpDirectTools: input.mcpDirectTools,
    mcpToolResolver: input.mcpToolResolver,
    cwd: input.cwd,
    requireReadTool: input.requireReadTool,
    excludeTools: input.excludeTools,
    structuredOutput: Boolean(input.structuredOutput),
    teamToolEnabled: Boolean(input.teamMember) || input.teamToolEnabled === true,
    capabilityCeiling: input.capabilityCeiling,
    inheritSkills: input.inheritSkills,
  });
  const { toolPlan, ...sdkResources } = resourcePlan;
  if (toolPlan.explicitToolAllowlist) {
    // An empty allowlist means no tools at all, which is a different flag rather
    // than an empty `--tools` value.
    args.push(toolPlan.effectiveToolAllowlist.length > 0 ? TOOLS_FLAG : NO_TOOLS_FLAG);
    if (toolPlan.effectiveToolAllowlist.length > 0) args.push(toolPlan.effectiveToolAllowlist.join(','));
  }
  if (toolPlan.excludedTools.length > 0) {
    args.push(EXCLUDE_TOOLS_FLAG, toolPlan.excludedTools.join(','));
  }
  if (toolPlan.disableAmbientExtensions) {
    args.push(NO_EXTENSIONS_FLAG);
  }
  for (const extPath of toolPlan.extensionArgs) args.push(EXTENSION_FLAG, extPath);

  if (!input.inheritProjectContext) {
    args.push(NO_CONTEXT_FILES_FLAG);
  }
  if (!input.inheritSkills) {
    args.push(NO_SKILLS_FLAG);
  }

  let tempDir: string | undefined;
  const ensureTempDir = (): string => {
    tempDir ??= createLaunchTempDir();
    return tempDir;
  };

  if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
    const stem = (input.promptFileStem ?? DEFAULT_PROMPT_FILE_STEM).replace(UNSAFE_PROMPT_STEM_CHARACTERS, '_');
    const promptPath = path.join(ensureTempDir(), `${stem}${PROMPT_FILE_EXTENSION}`);
    fs.writeFileSync(promptPath, input.systemPrompt, { mode: PRIVATE_FILE_MODE });
    args.push(input.systemPromptMode === 'replace' ? SYSTEM_PROMPT_FLAG : APPEND_SYSTEM_PROMPT_FLAG, promptPath);
  }

  if (input.task.length > TASK_ARG_LIMIT) {
    const taskFilePath = path.join(ensureTempDir(), TASK_FILE_NAME);
    fs.writeFileSync(taskFilePath, `${TASK_PREFIX}${input.task}`, { mode: PRIVATE_FILE_MODE });
    args.push(`@${taskFilePath}`);
  } else {
    args.push(`${TASK_PREFIX}${input.task}`);
  }

  // Team membership vars are always written: the clearing form blanks whatever
  // this process inherited so a non-team child cannot join its parent's team.
  const env: Record<string, string | undefined> = {
    ...(input.teamMember ? nativeTeamMemberEnvironment(input.teamMember) : clearNativeTeamMemberEnvironment()),
  };
  // A detached child cannot use the host's in-process module aliasing, so the
  // Pi package root travels by env var. Resolution tiers: an inherited value,
  // the strict entry-point walk (the host IS Pi), a Pi installation near the
  // host's entry (the host embeds Pi, as the DoomPi CLI does), then this
  // module's own resolver, which works when the SDK is installed on disk but
  // not when the host aliases it in-process only.
  const piPackageRoot =
    process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] ??
    resolvePiPackageRoot() ??
    resolvePiPackageRootNearHost() ??
    installedPiPackageRootOrUndefined();
  if (piPackageRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = piPackageRoot;
  let toolDiagnosticPath: string | undefined;
  if (toolPlan.requiredChildTools.length > 0) {
    toolDiagnosticPath = path.join(ensureTempDir(), TOOL_DIAGNOSTIC_FILE_NAME);
    env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(toolPlan.requiredChildTools);
    env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = toolDiagnosticPath;
  }
  env[MCP_DIRECT_CHILD_TOOLS_ENV] =
    toolPlan.effectiveMcpTools.length > 0 ? JSON.stringify(toolPlan.effectiveMcpTools) : undefined;
  env[SUBAGENT_CHILD_ENV] = ENABLED_ENV_VALUE;
  env[SUBAGENT_FANOUT_CHILD_ENV] = toolPlan.fanoutAuthorized ? ENABLED_ENV_VALUE : DISABLED_ENV_VALUE;
  // We are ourselves a nested child only if our parent granted us the full
  // fan-out route; a partial set of inherited vars is not trusted.
  const inheritedNestedRoute = Boolean(
    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] &&
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] &&
    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
  );
  const parentRunId =
    input.parentRunId ??
    input.runId ??
    (inheritedNestedRoute ? process.env[SUBAGENT_RUN_ID_ENV] : undefined) ??
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] ??
    '';
  const parentChildIndex =
    input.parentChildIndex !== undefined
      ? String(input.parentChildIndex)
      : input.childIndex !== undefined
        ? String(input.childIndex)
        : (process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] ?? '');
  const inheritedDepth = Number(process.env[SUBAGENT_PARENT_DEPTH_ENV]);
  const parentDepth =
    input.parentDepth ??
    (inheritedNestedRoute && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : ROOT_FANOUT_DEPTH);
  const parentPath = input.parentPath ?? [
    ...parseNestedPathEnv(process.env[SUBAGENT_PARENT_PATH_ENV]),
    ...(parentRunId
      ? [
          {
            runId: parentRunId,
            ...(parentChildIndex && DIGITS_ONLY.test(parentChildIndex) ? { stepIndex: Number(parentChildIndex) } : {}),
            ...(input.childAgentName ? { agent: input.childAgentName } : {}),
          },
        ]
      : []),
  ];
  // Blanked rather than omitted when fan-out is not authorized: an omitted key
  // would let the child inherit this process's own value.
  env[SUBAGENT_PARENT_EVENT_SINK_ENV] = toolPlan.fanoutAuthorized
    ? (input.parentEventSink ?? process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] ?? '')
    : '';
  env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = toolPlan.fanoutAuthorized
    ? (input.parentControlInbox ?? process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] ?? '')
    : '';
  env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = toolPlan.fanoutAuthorized
    ? (input.parentRootRunId ?? process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] ?? input.runId ?? '')
    : '';
  env[SUBAGENT_PARENT_RUN_ID_ENV] = toolPlan.fanoutAuthorized ? parentRunId : '';
  env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = toolPlan.fanoutAuthorized ? parentChildIndex : '';
  env[SUBAGENT_PARENT_DEPTH_ENV] = toolPlan.fanoutAuthorized ? String(parentDepth) : '';
  env[SUBAGENT_PARENT_PATH_ENV] = toolPlan.fanoutAuthorized ? encodeNestedPathEnv(parentPath) : '';
  env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = toolPlan.fanoutAuthorized
    ? (input.parentCapabilityToken ?? process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] ?? '')
    : '';
  env[INHERIT_PROJECT_CONTEXT_ENV] = input.inheritProjectContext ? ENABLED_ENV_VALUE : DISABLED_ENV_VALUE;
  env[INHERIT_SKILLS_ENV] = input.inheritSkills ? ENABLED_ENV_VALUE : DISABLED_ENV_VALUE;
  env[PI_INTERCOM_STABLE_ID_ENV] = input.intercomSessionName || undefined;
  // Cleared unconditionally: an inherited session id would make the child adopt
  // its parent's intercom identity.
  env[PI_INTERCOM_SESSION_ID_ENV] = undefined;
  if (input.intercomSessionName) {
    env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = input.intercomSessionName;
  }
  if (input.runId) {
    env[SUBAGENT_RUN_ID_ENV] = input.runId;
  }
  if (input.childAgentName) {
    env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
  }
  if (input.childIndex !== undefined) {
    env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
  }
  // The Pi host reads its own selector list from this var. Without a ceiling the
  // caller's selectors pass through; with one, only the selectors that survived
  // filtering do, and anything else resolves to the explicit "none" sentinel.
  if (!toolPlan.capabilityCeiling && input.mcpDirectTools?.length)
    env[MCP_DIRECT_TOOLS_ENV] = input.mcpDirectTools.join(',');
  else if (
    toolPlan.capabilityCeiling &&
    toolPlan.effectiveMcpSelections.length &&
    !toolPlan.capabilityCeiling.denyExtensions
  )
    env[MCP_DIRECT_TOOLS_ENV] = toolPlan.effectiveMcpSelections.map((selection) => selection.selector).join(',');
  else env[MCP_DIRECT_TOOLS_ENV] = NO_MCP_DIRECT_TOOLS;
  const encodedCapabilityCeiling = encodeSubagentCapabilityCeiling(toolPlan.capabilityCeiling);
  if (encodedCapabilityCeiling) env[SUBAGENT_CAPABILITY_CEILING_ENV] = encodedCapabilityCeiling;
  if (input.structuredOutput) {
    env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
    env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
  }
  if (input.steerInboxDir) {
    env[SUBAGENT_STEER_INBOX_ENV] = input.steerInboxDir;
  }
  if (input.steerCapabilityPath) env[SUBAGENT_STEER_CAPABILITY_ENV] = input.steerCapabilityPath;
  if (input.steerAckDir) env[SUBAGENT_STEER_ACK_DIR_ENV] = input.steerAckDir;
  const encodedToolBudget = encodeToolBudgetEnv(input.toolBudget);
  if (encodedToolBudget) env[TOOL_BUDGET_ENV] = encodedToolBudget;
  env[TOOL_BUDGET_ZERO_AUTH_ENV] = input.allowZeroToolBudget ? ENABLED_ENV_VALUE : undefined;
  env[SUBAGENT_PROTECTED_PARENT_PIDS_ENV] = JSON.stringify(
    [
      ...new Set([
        ...decodeProtectedParentProcessIds(process.env[SUBAGENT_PROTECTED_PARENT_PIDS_ENV]),
        process.pid,
        process.ppid,
      ]),
    ].filter((pid) => Number.isSafeInteger(pid) && pid > 1),
  );
  env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? '';
  env[DOOM_CHILD_PROCESS_CONTEXT_ENV] = input.parentSessionId
    ? encodeChildProcessContext({
        parentSessionId: input.parentSessionId,
        workingDirectory: input.cwd ?? process.cwd(),
        ...(input.childAgentName ? { mode: input.childAgentName } : {}),
      })
    : undefined;

  const sdk: PiSdkLaunchSettings = {
    ...(input.model || input.thinking ? { model: applyThinkingSuffix(input.model, input.thinking) } : {}),
    ...sdkResources,
    noContextFiles: !input.inheritProjectContext,
    sessionEnabled: input.sessionEnabled,
    ...(input.sessionDir ? { sessionDir: input.sessionDir } : {}),
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    ...(input.systemPrompt !== undefined && input.systemPrompt !== null ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.systemPromptMode ? { systemPromptMode: input.systemPromptMode } : {}),
  };

  env[DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV] = createChildPromptCacheProjection(
    {
      systemPrompt: sdk.systemPrompt,
      tools: sdk.tools ?? [],
      excludedTools: sdk.excludeTools ?? [],
      extensions: sdk.extensions,
      inheritProjectContext: input.inheritProjectContext,
      inheritSkills: input.inheritSkills,
      fanout: toolPlan.fanoutAuthorized,
      structuredOutputSchema: input.structuredOutput?.schema,
    },
    sha256Base64Url,
  );
  const parentCacheNamespace = process.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV];
  if (parentCacheNamespace) env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV] = parentCacheNamespace;
  const rootCacheSession = process.env[DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV];
  if (rootCacheSession) env[DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV] = rootCacheSession;

  return { args, env, sdk, tempDir, toolDiagnosticPath, capabilityAudit: toolPlan.capabilityAudit };
}

export const parseParentPathEnv = parseNestedPathEnv;

export function cleanupTempDir(tempDir: string | null | undefined): boolean {
  if (!tempDir) return true;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  } catch {
    // The child may still hold the prompt file open. Reporting false lets the
    // caller record the leak; throwing would fail a run that already succeeded.
    return false;
  }
}
