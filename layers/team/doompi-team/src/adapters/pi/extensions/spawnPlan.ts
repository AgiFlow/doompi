/**
 * Turns `subagent` tool params into a resolved sequence of
 * `AsyncSubagentSpawner.spawn()` calls: SINGLE (one child), PARALLEL (N
 * children, bounded by `concurrency`).
 *
 * WHY THIS IS NEW LOGIC, NOT COMPOSITION:
 * `AsyncSubagentSpawner` is deliberately a per-child primitive -
 * `childIndex`/`fanout` arrive as inputs it does not derive (see that
 * module's header). Nothing else in this package decides "how many
 * children, in what order, at what `childIndex`" from a `subagent` tool
 * call. That decision is this file's job.
 *
 * PREFLIGHT, ALL-OR-NOTHING:
 * `resolveCurrentSubagentDepth`/`preflightSubagentDepth` run once, before
 * anything spawns. A depth refusal throws - a declared plan that cannot run
 * at all should produce one clear refusal, not a partial fan-out.
 * `AgentDiscoveryService.find` resolves and validates every child's agent
 * name up front too, for the same reason: a typo'd agent name is a
 * preflight failure named at the tool boundary, not a spawn error surfacing
 * deep inside one child while its siblings are already running.
 *
 * ONCE THE BATCH HAS STARTED, PER-CHILD FAILURE IS A RESULT, NOT AN
 * EXCEPTION:
 * `runWithConcurrency` never lets one child's rejection abort its siblings,
 * matching `failFast` being opt-in in the schema, not the default. Every
 * child gets an outcome - `{runId, pid}` on success, `{error}` on failure -
 * and the caller (`subagentTool.ts`) decides how to report a mixed batch.
 *
 * WHAT THIS DOES NOT WIRE YET, AND WHY - FLAGGED, NOT SILENTLY GUESSED:
 * - `maxSubagentSpawnsPerSession` (`spawn-budget.ts`) is NOT enforced here.
 *   `preflightSpawnBudget` needs a durable, session-scoped `SpawnBudgetStore`
 *   that accumulates spend ACROSS separate tool calls in the same session;
 *   inventing a fresh store per call would never track real spend and would
 *   be worse than not checking at all (false confidence). Wiring this needs
 *   a real session-scoped store owned by a lifecycle-bound service - a
 *   follow-up, not guessed here.
 * - Fork context is resolved here and requires a captured persisted Pi source;
 *   unavailable or non-Pi fork requests fail closed rather than becoming fresh
 *   launches.
 * - Per-task overrides with no direct `BuildPiArgsInput` field confirmed yet
 *   (`skill`, `toolBudget`, `turnBudget`, `outputSchema`/structured output,
 *   `acceptance`, `output`/`outputMode`) are not mapped into `piArgs` for
 *   v1. Each child still gets its resolved `AgentConfig`'s own defaults
 *   (`systemPromptMode`, `inheritProjectContext`, `inheritSkills`,
 *   `systemPrompt`) - not nothing, just not every param override yet.
 *
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InlineAgent } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PI_RUNTIME_NAME } from '../../../types/environment';
import {
  type ResolvedSubagentCapabilityCeiling,
  SubagentCapabilityPolicyStore,
} from '../../../schemas/team/capabilityCeiling';
import { resolveActiveTeamModelSpecs, resolveActiveTeamPackageConfig } from '../../agents/discovery';
import { canonicalizeDiscoveryCwd } from '../../agents/projectRoot';
import { buildSkillInjection, type SkillDiscoveryContract } from '../../agents/skills';
import type { AgentConfig, AgentScope, AgentDiscoveryContract } from '../../agents/types';
import type {
  AsyncSubagentSpawnInput,
  AsyncSubagentSpawnResult,
  AsyncSubagentSpawnerContract,
} from '../../runs/background/asyncExecution';
import { preflightSubagentDepth, resolveCurrentSubagentDepth } from '../../runs/shared/depthGuard';
import { type AvailableModelInfo, type ParentModel, selectAvailableModel } from '../../runs/shared/modelFallback';
import type { McpDirectToolResolver } from '../../runs/shared/mcpDirectToolAllowlist';
import {
  isPiRuntime,
  type RuntimeTable,
  resolveRuntimeLaunch,
  resolveRuntimeTable,
} from '../../runs/shared/runtimeRegistry';
import { type ConcurrencyEventReporter, runWithConcurrency } from '../../runs/shared/runWithConcurrency';
import {
  type AdmissionGateContract,
  type AdmissionTicket,
  DEFAULT_ADMISSION_TIMEOUT_MS,
  sharedAdmissionGate,
} from '../../runs/shared/admissionGate';
import { DoomTeamExpectedError } from '../../../services/support/errors';
import type { ExtensionConfig } from './config';

const CONTEXT_FRESH = 'fresh' as const;
const CONTEXT_FORK = 'fork' as const;
const PI_RUNTIME_REQUIREMENT = `runtime "${PI_RUNTIME_NAME}"`;

type SessionForkCaptureMode = 'tool' | 'settled';

export interface SessionForkSource {
  sessionFile: string;
  leafId: string;
}

export type SessionForkSourceManager = Pick<SessionManager, 'getSessionFile' | 'getLeafId' | 'getLeafEntry'>;

function readableSessionFile(sessionFile: string | undefined): sessionFile is string {
  if (!sessionFile?.trim()) return false;
  try {
    fs.accessSync(sessionFile, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Capture the parent branch while excluding an assistant turn whose tool is still executing. */
export function captureSessionForkSource(
  manager: SessionForkSourceManager,
  mode: SessionForkCaptureMode,
): SessionForkSource | undefined {
  const sessionFile = manager.getSessionFile();
  if (!readableSessionFile(sessionFile)) return undefined;

  const leaf = manager.getLeafEntry();
  const leafId =
    mode === 'tool' && leaf?.type === 'message' && leaf.message.role === 'assistant'
      ? leaf.parentId
      : (leaf?.id ?? manager.getLeafId());
  return leafId ? { sessionFile, leafId } : undefined;
}

function isSessionForkSourceAvailable(source: SessionForkSource): boolean {
  return Boolean(source.leafId.trim()) && readableSessionFile(source.sessionFile);
}

export interface SpawnPlanTaskInput {
  agent: string;
  inlineAgent?: InlineAgent;
  task?: string;
  cwd?: string;
  model?: string;
  runtime?: string;
  context?: typeof CONTEXT_FRESH | typeof CONTEXT_FORK;
  /**
   * An existing child transcript to continue instead of starting fresh.
   *
   * Set only by a restore. `sdkRunnerEntry.ts` opens it through
   * `SessionManager.open`, which is what makes a restored run pick up where it
   * was suspended rather than redo the task.
   */
  sessionFile?: string;
}

type ExecutableAgentConfig = Pick<
  AgentConfig,
  | 'name'
  | 'defaultContext'
  | 'defaultReads'
  | 'extensions'
  | 'fallbackModels'
  | 'inheritProjectContext'
  | 'inheritSkills'
  | 'mcpDirectTools'
  | 'model'
  | 'modelSource'
  | 'runtime'
  | 'skills'
  | 'skillPath'
  | 'subagentOnlyExtensions'
  | 'systemPrompt'
  | 'systemPromptMode'
  | 'thinking'
  | 'tools'
>;

function resolveEffectiveContext(
  taskInput: SpawnPlanTaskInput,
  agent: Pick<ExecutableAgentConfig, 'defaultContext'>,
): typeof CONTEXT_FRESH | typeof CONTEXT_FORK {
  return taskInput.sessionFile ? CONTEXT_FRESH : (taskInput.context ?? agent.defaultContext ?? CONTEXT_FRESH);
}

export interface SpawnPlanRequest {
  /** SINGLE mode: exactly one child. Mutually exclusive with `tasks`. */
  single?: SpawnPlanTaskInput;
  /** PARALLEL mode: N children, fanned out. Mutually exclusive with `single`. */
  tasks?: SpawnPlanTaskInput[];
  /** Max children in flight at once for PARALLEL mode. Ignored for SINGLE. Defaults to `config.parallel.concurrency` or 4. */
  concurrency?: number;
  /** Fallback cwd for any task that omits its own. */
  cwd: string;
  agentScope: AgentScope;
  /** Legacy session identity retained for delegation correlation. */
  parentSessionId?: string;
  /** Persisted parent transcript used for true Pi forks. */
  parentSessionFile?: string;
  /** Settled parent leaf used for true Pi forks. */
  parentLeafId?: string;
  artifacts?: boolean;
  /** Authenticated models reported by the live parent host. Undefined for callers without a host context. */
  availableModels?: AvailableModelInfo[];
  /** The live parent model, forwarded only for Pi child selection. */
  parentModel?: ParentModel;
  /** Overrides `resolveCurrentSubagentDepth()`'s own env read - a test seam, not a runtime path. */
  currentDepth?: number;
  /** Which runtime executes every child of this request. Defaults per agent, then to `pi`. */
  runtime?: string;
  /** Stable Pi tool-call identity used to correlate this batch. */
  operationId?: string;
  /** Run ids persisted by the operation journal before any process starts. */
  preallocatedRunIds?: string[];
}

/** Everything one child spawn needs. An object because this reached ten positional parameters. */
interface SpawnOneChildInput {
  runId: string;
  operationId?: string;
  agentConfig: ExecutableAgentConfig;
  excludeTools?: string[];
  teamPackageModels?: string[];
  capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
  taskInput: SpawnPlanTaskInput;
  childIndex: number;
  fanout: boolean;
  fallbackCwd: string;
  parentSessionId: string | undefined;
  parentSessionFile: string | undefined;
  preparedSessionFile: string | undefined;
  maxLiveRuns: number;
  admissionTimeoutMs: number;
  handshakeTimeoutMs: number | undefined;
  artifacts: boolean | undefined;
  artifactDir: ExtensionConfig['artifactDir'];
  availableModels: AvailableModelInfo[] | undefined;
  parentModel: ParentModel | undefined;
  runtime: string | undefined;
  runtimes: RuntimeTable;
  skillProjectionCache: Map<string, ChildSkillProjection>;
}

export interface SpawnPlanChildOutcome {
  agent: string;
  task: string;
  /** This spawn's position among its siblings. Always 0 for SINGLE mode. */
  childIndex: number;
  runId?: string;
  pid?: number;
  error?: string;
  warning?: string;
}

export interface SpawnPlanResult {
  outcomes: SpawnPlanChildOutcome[];
}

const DEFAULT_PARALLEL_CONCURRENCY = 4;
/**
 * Hard ceiling on how many children one PARALLEL call may DECLARE.
 *
 * `concurrency` does NOT bound this, and cannot: `spawnOneChild` resolves as
 * soon as its child confirms it started, and the child then runs detached. So
 * `runWithConcurrency` throttles how fast children are STARTED, not how many
 * are running - `{tasks: [8], concurrency: 4}` ends up with eight live model
 * processes, not four. 8 matches the sibling implementation's
 * `PI_TEAM_MATE_MAX_PARALLEL`.
 *
 * This is a per-call declaration limit and nothing more. What actually bounds
 * live children across concurrent calls is `AdmissionGate`
 * (`runs/shared/admissionGate.ts`), which every spawn passes through.
 */
const DEFAULT_PARALLEL_MAX_TASKS = 8;
/**
 * Process-wide ceiling on children ALIVE at once.
 *
 * Defaulted to `DEFAULT_PARALLEL_MAX_TASKS` so a single call's width is
 * exactly what it was before the gate existed; the only behaviour that
 * changes is that a second overlapping call now queues instead of stacking
 * another full batch on the machine. Raise or lower it with
 * `parallel.maxLiveRuns` in the subagent config, and bound the queue wait with
 * `parallel.admissionTimeoutMs`. It is deliberately NOT derived from the host's
 * cores or memory: a number measured on one machine is not a default.
 */
const DEFAULT_MAX_LIVE_RUNS = DEFAULT_PARALLEL_MAX_TASKS;
const INLINE_AGENT_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

function appendPromptSection(prompt: string, section: string): string {
  if (!section) return prompt;
  return prompt ? `${prompt}\n\n${section}` : section;
}

function bestEffortRuntimeWarnings(
  runtime: string,
  agentConfig: ExecutableAgentConfig,
  excludeTools: string[] | undefined,
): string[] {
  if (isPiRuntime(runtime)) return [];

  const warnings = [`Runtime '${runtime}' does not load Pi child extensions or hooks; launched best effort.`];
  const unsupportedResources = [
    ...(agentConfig.tools !== undefined || agentConfig.mcpDirectTools?.length ? ['tools'] : []),
    ...(agentConfig.skills?.length || agentConfig.skillPath?.length ? ['skills'] : []),
    ...(agentConfig.extensions !== undefined || agentConfig.subagentOnlyExtensions?.length ? ['extensions'] : []),
  ];
  if (unsupportedResources.length > 0) {
    warnings.push(
      `Doom Team cannot project or enforce configured Pi ${unsupportedResources.join(', ')} on runtime '${runtime}'.`,
    );
  }
  if (agentConfig.skills?.length) {
    warnings.push(`Configured skills were not injected: ${agentConfig.skills.join(', ')}.`);
  }
  if (excludeTools?.length) {
    warnings.push(
      `Runtime '${runtime}' cannot enforce Team package tool exclusions; launched best effort for: ${excludeTools.join(', ')}.`,
    );
  }
  return warnings;
}

interface ChildSkillProjection {
  systemPrompt: string;
  requireReadTool: boolean;
  warnings: string[];
}

interface ResolvedModelSelection {
  primaryModel: string | undefined;
  fallbackModels: string[];
  model: string | undefined;
}

function resolvedModelSelection(
  taskInput: SpawnPlanTaskInput,
  agentConfig: Pick<ExecutableAgentConfig, 'model' | 'modelSource' | 'fallbackModels'>,
  runtime: string,
  parentModel: ParentModel | undefined,
  availableModels: AvailableModelInfo[] | undefined,
  teamPackageModels: string[] | undefined,
): ResolvedModelSelection {
  const parentModelId =
    isPiRuntime(runtime) && parentModel && availableModels !== undefined
      ? `${parentModel.provider}/${parentModel.id}`
      : undefined;
  const agentModels = [
    ...(agentConfig.modelSource?.scope === 'package' ? [] : [agentConfig.model]),
    ...(agentConfig.fallbackModels ?? []),
  ];
  const ordered = isPiRuntime(runtime)
    ? [taskInput.model, ...agentModels, ...(teamPackageModels ?? []), parentModelId]
    : [taskInput.model, ...agentModels, ...(teamPackageModels ?? [])];
  const candidates = ordered.filter((candidate): candidate is string => Boolean(candidate?.trim()));
  const [primaryModel, ...fallbackModels] = candidates;
  return {
    primaryModel,
    fallbackModels,
    model: selectAvailableModel(primaryModel, fallbackModels, availableModels),
  };
}

export interface SpawnPlannerContract {
  /**
   * Resolves the plan and spawns every child. Throws on any PREFLIGHT
   * failure (bad request shape, depth exceeded, unknown agent) before
   * anything spawns. Never throws for an individual child's spawn failure
   * once the batch has started - that is a `{error}` outcome instead.
   */
  spawn(request: SpawnPlanRequest, config: ExtensionConfig): Promise<SpawnPlanResult>;
}

const ERROR_CODE_AGENT_NOT_FOUND = 'agent_not_found' as const;
const ERROR_CODE_INVALID_REQUEST = 'invalid_request' as const;
const ERROR_CODE_MODEL_UNAVAILABLE = 'model_unavailable' as const;
const ERROR_CODE_OPERATION_CONFLICT = 'operation_conflict' as const;
const ERROR_CODE_RUNTIME_UNAVAILABLE = 'runtime_unavailable' as const;
const ERROR_CODE_UNSUPPORTED_CONTEXT = 'unsupported_context' as const;
const ERROR_CODE_UNSUPPORTED_OPERATION = 'unsupported_operation' as const;

export class SpawnPlanner implements SpawnPlannerContract {
  constructor(
    private readonly agents: AgentDiscoveryContract,
    private readonly spawner: AsyncSubagentSpawnerContract,
    private readonly policies: SubagentCapabilityPolicyStore = new SubagentCapabilityPolicyStore(),
    private readonly skills?: SkillDiscoveryContract,
    private readonly reportConcurrencyEvent?: ConcurrencyEventReporter,
    private readonly mcpToolResolver?: McpDirectToolResolver,
    private readonly admission: AdmissionGateContract = sharedAdmissionGate(),
  ) {}

  protected generateRunId(): string {
    return crypto.randomUUID();
  }

  protected createForkSessionFile(source: SessionForkSource, cwd: string): string {
    const sessionManager = SessionManager.open(source.sessionFile, undefined, cwd);
    const sessionFile = sessionManager.createBranchedSession(source.leafId);
    if (!sessionFile) throw new Error(`Could not create a branched Pi session from '${source.sessionFile}'.`);

    // Pi defers writing user-only branches until an assistant response. A tool-safe
    // fork usually ends at the user message immediately before the active tool call,
    // so materialize that valid child transcript before the runner opens it.
    if (!fs.existsSync(sessionFile)) {
      const header = sessionManager.getHeader();
      if (!header) throw new Error(`Forked Pi session '${sessionFile}' has no header.`);
      const records = [header, ...sessionManager.getEntries()];
      fs.writeFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { flag: 'wx' });
    }
    return sessionFile;
  }

  protected removePreparedSessionFile(sessionFile: string): void {
    fs.rmSync(sessionFile, { force: true });
  }

  protected validateCwd(cwd: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new DoomTeamExpectedError(
        ERROR_CODE_INVALID_REQUEST,
        `Working directory '${cwd}' does not exist.`,
        false,
        'Retry with an existing directory.',
      );
    }
    if (!stat.isDirectory()) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_INVALID_REQUEST,
        `Working directory '${cwd}' is not a directory.`,
        false,
        'Retry with an existing directory.',
      );
    }
  }

  protected resolveTeamPackageExcludeTools(): string[] | undefined {
    return resolveActiveTeamPackageConfig()?.config.excludeTools;
  }

  protected resolveTeamPackageModels(): string[] | undefined {
    return resolveActiveTeamModelSpecs();
  }

  protected executableAvailable(command: string): boolean {
    if (path.isAbsolute(command) || command.includes(path.sep)) {
      try {
        fs.accessSync(command, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .some((directory) => {
        try {
          fs.accessSync(path.join(directory, command), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
  }

  private resolveTaskList(request: SpawnPlanRequest): SpawnPlanTaskInput[] {
    const hasSingle = request.single !== undefined;
    const hasTasks = request.tasks !== undefined;
    if (hasSingle === hasTasks) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_INVALID_REQUEST,
        'A run requires exactly one of internal single or tasks representations.',
        false,
        'Submit a non-empty requests array.',
      );
    }
    if (hasSingle) return [request.single!];
    if (!request.tasks || request.tasks.length === 0) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_INVALID_REQUEST,
        'A run requires at least one entry in its requests collection.',
        false,
        'Submit a non-empty requests array.',
      );
    }
    return request.tasks;
  }

  private resolveAgentOrThrow(name: string, cwd: string, scope: AgentScope) {
    const resolved = this.agents.find(cwd, scope, name);
    if (!resolved) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_AGENT_NOT_FOUND,
        `Unknown agent '${name}'.`,
        false,
        'Call subagent({"action":"agents"}) and retry with an exact name.',
      );
    }
    return resolved;
  }

  private resolveExecutableAgent(taskInput: SpawnPlanTaskInput, cwd: string, scope: AgentScope): ExecutableAgentConfig {
    if (!taskInput.inlineAgent) return this.resolveAgentOrThrow(taskInput.agent, cwd, scope);
    return {
      name: taskInput.agent.trim(),
      systemPromptMode: 'append',
      inheritProjectContext: true,
      inheritSkills: false,
      systemPrompt: taskInput.inlineAgent.systemPrompt.trim(),
      tools: [...INLINE_AGENT_TOOLS],
      defaultContext: CONTEXT_FRESH,
      runtime: PI_RUNTIME_NAME,
    };
  }

  private projectDefaultReads(
    defaultReads: string[] | undefined,
    childCwd: string,
    agentName: string,
  ): ChildSkillProjection {
    if (!defaultReads?.length) return { systemPrompt: '', requireReadTool: false, warnings: [] };

    const seen = new Set<string>();
    const readablePaths: string[] = [];
    const missingPaths: string[] = [];
    for (const configuredPath of defaultReads) {
      const trimmed = configuredPath.trim();
      if (!trimmed) continue;
      const resolvedPath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(childCwd, trimmed);
      const identity = canonicalizeDiscoveryCwd(resolvedPath);
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        if (fs.statSync(resolvedPath).isFile()) readablePaths.push(resolvedPath);
        else missingPaths.push(resolvedPath);
      } catch {
        missingPaths.push(resolvedPath);
      }
    }

    const systemPrompt =
      readablePaths.length > 0
        ? [
            'Read these configured paths before broad repository discovery:',
            ...readablePaths.map((readPath) => `- ${readPath}`),
            'If a listed path does not provide enough context, name the concrete missing dependency before searching narrowly for it.',
          ].join('\n')
        : '';
    return {
      systemPrompt,
      requireReadTool: readablePaths.length > 0,
      warnings:
        missingPaths.length > 0
          ? [`Agent '${agentName}' could not read optional default paths: ${missingPaths.join(', ')}.`]
          : [],
    };
  }

  private projectConfiguredSkills(
    agentConfig: ExecutableAgentConfig,
    childCwd: string,
    requestCwd: string,
    runtime: string,
    cache: Map<string, ChildSkillProjection>,
  ): ChildSkillProjection {
    const cacheKey = JSON.stringify([
      canonicalizeDiscoveryCwd(childCwd),
      canonicalizeDiscoveryCwd(requestCwd),
      runtime,
      agentConfig.name,
      agentConfig.systemPrompt,
      agentConfig.skills ?? [],
      agentConfig.skillPath ?? [],
      agentConfig.defaultReads ?? [],
    ]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    if (!isPiRuntime(runtime)) {
      const projection = { systemPrompt: agentConfig.systemPrompt, requireReadTool: false, warnings: [] };
      cache.set(cacheKey, projection);
      return projection;
    }

    const defaultReads = this.projectDefaultReads(agentConfig.defaultReads, childCwd, agentConfig.name);
    let skillInjection = '';
    let skillWarnings: string[] = [];
    if (agentConfig.skills?.length) {
      if (!this.skills) throw new Error('Skill discovery is unavailable for configured child skills.');
      const resolution = this.skills.resolveSkillsWithFallback(
        agentConfig.skills,
        childCwd,
        requestCwd,
        agentConfig.skillPath,
        requestCwd,
      );
      skillInjection = buildSkillInjection(resolution.resolved);
      skillWarnings =
        resolution.missing.length > 0
          ? [
              `Agent '${agentConfig.name}' could not resolve configured skills: ${resolution.missing.join(', ')}; launched with resolved skills only.`,
            ]
          : [];
    }

    const projection = {
      systemPrompt: appendPromptSection(
        appendPromptSection(agentConfig.systemPrompt, skillInjection),
        defaultReads.systemPrompt,
      ),
      requireReadTool: skillInjection.length > 0 || defaultReads.requireReadTool,
      warnings: [...skillWarnings, ...defaultReads.warnings],
    };
    cache.set(cacheKey, projection);
    return projection;
  }

  /**
   * Spawns exactly one child and returns its outcome. Shared by `spawn()`
   * (SINGLE/PARALLEL) and `spawnChain()`'s per-step/per-parallel-group-child
   * calls, so the `AsyncSubagentSpawnInput` mapping exists in exactly one
   * place. Never throws - a spawn failure becomes an `{error}` outcome, per
   * the "preflight throws, per-child failure does not" split documented in
   * the module header.
   */
  private async spawnOneChild(input: SpawnOneChildInput): Promise<SpawnPlanChildOutcome> {
    const {
      runId,
      operationId,
      agentConfig,
      capabilityCeiling,
      excludeTools,
      teamPackageModels,
      taskInput,
      childIndex,
      fanout,
      fallbackCwd,
      parentSessionId,
      parentSessionFile,
      preparedSessionFile,
      maxLiveRuns,
      admissionTimeoutMs,
      handshakeTimeoutMs,
      artifacts,
      artifactDir,
      availableModels,
      parentModel,
      runtime,
      runtimes,
      skillProjectionCache,
    } = input;
    const cwd = taskInput.cwd ?? fallbackCwd;
    const task = taskInput.task ?? '';
    const effectiveContext = resolveEffectiveContext(taskInput, agentConfig);
    const effectiveRuntime = taskInput.runtime ?? runtime ?? agentConfig.runtime ?? PI_RUNTIME_NAME;
    const modelSelection = resolvedModelSelection(
      taskInput,
      agentConfig,
      effectiveRuntime,
      parentModel,
      availableModels,
      teamPackageModels,
    );
    if (modelSelection.primaryModel && availableModels !== undefined && !modelSelection.model) {
      return {
        agent: agentConfig.name,
        task,
        childIndex,
        error: `No authenticated model is available for '${agentConfig.name}'. Checked: ${[
          modelSelection.primaryModel,
          ...modelSelection.fallbackModels,
        ].join(', ')}.`,
      };
    }

    let skillProjection: ChildSkillProjection;
    try {
      skillProjection = this.projectConfiguredSkills(
        agentConfig,
        cwd,
        fallbackCwd,
        effectiveRuntime,
        skillProjectionCache,
      );
    } catch (error) {
      return {
        agent: agentConfig.name,
        task,
        childIndex,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const warnings = [
      ...skillProjection.warnings,
      ...bestEffortRuntimeWarnings(effectiveRuntime, agentConfig, excludeTools),
    ];
    const warning = warnings.length > 0 ? warnings.join(' ') : undefined;

    // Persist every Pi child's own transcript so a later explicit restore can
    // continue it. External runtimes retain their existing session behavior.
    const spawnInput: AsyncSubagentSpawnInput = {
      runId,
      ...(operationId ? { operationId } : {}),
      agent: agentConfig.name,
      ...(taskInput.inlineAgent ? { inlineAgent: taskInput.inlineAgent } : {}),
      task,
      cwd,
      childIndex,
      fanout,
      ...(parentSessionFile ? { parentSessionFile } : {}),
      piArgs: {
        baseArgs: [],
        sessionEnabled: isPiRuntime(effectiveRuntime),
        ...(taskInput.sessionFile
          ? { sessionFile: taskInput.sessionFile }
          : preparedSessionFile
            ? { sessionFile: preparedSessionFile }
            : {}),
        inheritProjectContext: agentConfig.inheritProjectContext,
        inheritSkills: agentConfig.inheritSkills,
        systemPromptMode: agentConfig.systemPromptMode,
        systemPrompt: skillProjection.systemPrompt,
        requireReadTool: skillProjection.requireReadTool,
        model: modelSelection.model,
        thinking: agentConfig.thinking,
        tools: agentConfig.tools,
        extensions: agentConfig.extensions,
        subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
        mcpDirectTools: agentConfig.mcpDirectTools,
        ...(this.mcpToolResolver ? { mcpToolResolver: this.mcpToolResolver } : {}),
        excludeTools,
        capabilityCeiling,
        cwd,
        ...(effectiveContext === CONTEXT_FORK && parentSessionId ? { parentSessionId } : {}),
      },
      ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(artifactDir !== undefined ? { artifactDir } : {}),
      // Per-call `runtime` wins over the agent's own default, matching how
      // `model` and `context` already resolve.
      runtime: effectiveRuntime,
      runtimes,
    };

    let ticket: AdmissionTicket;
    try {
      ticket = await this.admission.admit({
        maxLiveRuns,
        timeoutMs: admissionTimeoutMs,
        ...(this.reportConcurrencyEvent ? { report: this.reportConcurrencyEvent } : {}),
      });
    } catch (error) {
      return {
        agent: agentConfig.name,
        task,
        childIndex,
        error: error instanceof Error ? error.message : String(error),
        ...(warning ? { warning } : {}),
      };
    }

    try {
      const result: AsyncSubagentSpawnResult = await this.spawner.spawn(spawnInput);
      return {
        agent: agentConfig.name,
        task,
        childIndex,
        runId: result.runId,
        pid: result.pid,
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      return {
        agent: agentConfig.name,
        task,
        childIndex,
        error: error instanceof Error ? error.message : String(error),
        ...(warning ? { warning } : {}),
      };
    } finally {
      // The child is in `runRegistry` by the time `spawn` resolves, so the
      // registry count takes over from this reservation.
      ticket.release();
    }
  }

  async spawn(request: SpawnPlanRequest, config: ExtensionConfig): Promise<SpawnPlanResult> {
    const tasks = this.resolveTaskList(request);
    const fanout = tasks.length > 1;
    const teamPackageExcludeTools = this.resolveTeamPackageExcludeTools();
    const teamPackageModels = this.resolveTeamPackageModels();
    const capabilityCeiling = this.policies.resolve();

    // PREFLIGHT - all before any spawn call, so a declared plan that cannot
    // run at all produces one refusal, not a partial fan-out.
    const currentDepth = request.currentDepth ?? resolveCurrentSubagentDepth();
    const depthCheck = preflightSubagentDepth(currentDepth, config);
    if (depthCheck.error) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_UNSUPPORTED_OPERATION,
        depthCheck.error,
        false,
        'Give each child a self-contained task within the Team package policy.',
      );
    }

    const maxTasks = config.parallel?.maxTasks ?? DEFAULT_PARALLEL_MAX_TASKS;
    if (tasks.length > maxTasks) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_INVALID_REQUEST,
        `Run requested ${tasks.length} tasks, but at most ${maxTasks} may be declared in one call. Concurrency throttles how fast they start, not how many run.`,
        false,
        'Send at most that many requests in this call and wait for them, or raise parallel.maxTasks in the subagent config. Splitting the same width across extra calls does not raise the live-child ceiling.',
      );
    }

    for (const taskInput of tasks) {
      if (!taskInput.task?.trim()) {
        throw new DoomTeamExpectedError(
          ERROR_CODE_INVALID_REQUEST,
          `Run request for '${taskInput.agent}' requires a nonblank task.`,
          false,
          'Provide a self-contained nonblank task.',
        );
      }
      if (taskInput.inlineAgent && !taskInput.inlineAgent.systemPrompt.trim()) {
        throw new DoomTeamExpectedError(
          ERROR_CODE_INVALID_REQUEST,
          `Inline agent '${taskInput.agent}' requires a nonblank system prompt.`,
          false,
          'Provide a focused read-only exploration role.',
        );
      }
    }

    const resolvedAgentCache = new Map<string, ExecutableAgentConfig>();
    const resolvedAgents = tasks.map((taskInput) => {
      if (taskInput.inlineAgent) {
        return this.resolveExecutableAgent(taskInput, taskInput.cwd ?? request.cwd, request.agentScope);
      }
      const cacheKey = [
        request.agentScope,
        canonicalizeDiscoveryCwd(taskInput.cwd ?? request.cwd),
        taskInput.agent,
      ].join('\0');
      const cached = resolvedAgentCache.get(cacheKey);
      if (cached) return cached;
      const resolved = this.resolveExecutableAgent(taskInput, taskInput.cwd ?? request.cwd, request.agentScope);
      resolvedAgentCache.set(cacheKey, resolved);
      return resolved;
    });
    for (const [index, taskInput] of tasks.entries()) {
      const effectiveContext = resolveEffectiveContext(taskInput, resolvedAgents[index]!);
      const runtime = taskInput.runtime ?? request.runtime ?? resolvedAgents[index]!.runtime ?? PI_RUNTIME_NAME;
      if (effectiveContext === CONTEXT_FORK) {
        if (!isPiRuntime(runtime)) {
          throw new DoomTeamExpectedError(
            ERROR_CODE_UNSUPPORTED_CONTEXT,
            `Fork context requires ${PI_RUNTIME_REQUIREMENT} for '${taskInput.agent}'.`,
            false,
            'Use a Pi agent for fork context or explicitly request a fresh run.',
          );
        }
        const source =
          request.parentSessionFile && request.parentLeafId
            ? { sessionFile: request.parentSessionFile, leafId: request.parentLeafId }
            : undefined;
        if (!source || !isSessionForkSourceAvailable(source)) {
          throw new DoomTeamExpectedError(
            ERROR_CODE_UNSUPPORTED_CONTEXT,
            `Fork context is unavailable for '${taskInput.agent}': the parent Pi session has no readable source.`,
            false,
            'Use an active persisted Pi session or explicitly request a fresh run.',
          );
        }
      }
    }

    if (request.preallocatedRunIds && request.preallocatedRunIds.length !== tasks.length) {
      throw new DoomTeamExpectedError(
        ERROR_CODE_OPERATION_CONFLICT,
        'The operation journal run-id count does not match the request count.',
        false,
        'Submit the run as a new tool call.',
      );
    }
    const runIds = request.preallocatedRunIds ?? tasks.map(() => this.generateRunId());
    const runtimes = resolveRuntimeTable(config.runtimes);
    for (const [index, taskInput] of tasks.entries()) {
      const agent = resolvedAgents[index]!;
      const cwd = taskInput.cwd ?? request.cwd;
      this.validateCwd(cwd);
      const runtime = taskInput.runtime ?? request.runtime ?? agent.runtime ?? PI_RUNTIME_NAME;
      const modelSelection = resolvedModelSelection(
        taskInput,
        agent,
        runtime,
        request.parentModel,
        request.availableModels,
        teamPackageModels,
      );
      if (modelSelection.primaryModel && request.availableModels !== undefined && !modelSelection.model) {
        throw new DoomTeamExpectedError(
          ERROR_CODE_MODEL_UNAVAILABLE,
          `No authenticated model is available for '${agent.name}'.`,
          false,
          'Authenticate the requested model or choose an available model.',
        );
      }
      if (taskInput.inlineAgent && !isPiRuntime(runtime)) {
        throw new DoomTeamExpectedError(
          ERROR_CODE_UNSUPPORTED_OPERATION,
          `Inline agent '${taskInput.agent}' requires ${PI_RUNTIME_REQUIREMENT} to enforce its read-only tools.`,
          false,
          'Remove the runtime override or use a discovered external-runtime agent without inlineAgent.',
        );
      }
      if (capabilityCeiling && !isPiRuntime(runtime)) {
        throw new DoomTeamExpectedError(
          ERROR_CODE_UNSUPPORTED_OPERATION,
          `Runtime '${runtime}' cannot enforce the active capability ceiling.`,
          false,
          `Use ${PI_RUNTIME_REQUIREMENT} while plan mode or another capability ceiling is active.`,
        );
      }
      if (!isPiRuntime(runtime)) {
        let command: string;
        try {
          command = resolveRuntimeLaunch(runtime, runtimes, { prompt: taskInput.task ?? '', cwd }).command;
        } catch (error) {
          throw new DoomTeamExpectedError(
            ERROR_CODE_RUNTIME_UNAVAILABLE,
            error instanceof Error ? error.message : String(error),
            false,
            `Configure a valid external runtime or use ${PI_RUNTIME_REQUIREMENT}.`,
          );
        }
        if (!this.executableAvailable(command)) {
          throw new DoomTeamExpectedError(
            ERROR_CODE_RUNTIME_UNAVAILABLE,
            `Executable '${command}' for runtime '${runtime}' is unavailable.`,
            false,
            `Install the executable, configure its absolute path, or use ${PI_RUNTIME_REQUIREMENT}.`,
          );
        }
      }
    }
    const forkSource =
      request.parentSessionFile && request.parentLeafId
        ? { sessionFile: request.parentSessionFile, leafId: request.parentLeafId }
        : undefined;
    const preparedSessionFiles: Array<string | undefined> = [];
    try {
      for (const [index, taskInput] of tasks.entries()) {
        preparedSessionFiles.push(
          resolveEffectiveContext(taskInput, resolvedAgents[index]!) === CONTEXT_FORK
            ? this.createForkSessionFile(forkSource!, taskInput.cwd ?? request.cwd)
            : undefined,
        );
      }
    } catch (error) {
      for (const sessionFile of preparedSessionFiles) {
        if (sessionFile) this.removePreparedSessionFile(sessionFile);
      }
      throw new DoomTeamExpectedError(
        ERROR_CODE_UNSUPPORTED_CONTEXT,
        error instanceof Error ? error.message : String(error),
        false,
        'Retry from an active persisted Pi session or explicitly request a fresh run.',
      );
    }

    const concurrency = fanout
      ? (request.concurrency ?? config.parallel?.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY)
      : 1;
    const maxLiveRuns = Math.max(1, config.parallel?.maxLiveRuns ?? DEFAULT_MAX_LIVE_RUNS);
    const admissionTimeoutMs = config.parallel?.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;

    const skillProjectionCache = new Map<string, ChildSkillProjection>();
    const factories = tasks.map(
      (taskInput, childIndex) => () =>
        this.spawnOneChild({
          runId: runIds[childIndex]!,
          operationId: request.operationId,
          agentConfig: resolvedAgents[childIndex]!,
          excludeTools: teamPackageExcludeTools,
          teamPackageModels,
          capabilityCeiling,
          taskInput,
          childIndex,
          fanout,
          fallbackCwd: request.cwd,
          parentSessionId: request.parentSessionId,
          parentSessionFile: request.parentSessionFile,
          preparedSessionFile: preparedSessionFiles[childIndex],
          maxLiveRuns,
          admissionTimeoutMs,
          handshakeTimeoutMs: config.handshakeTimeoutMs,
          artifacts: request.artifacts,
          artifactDir: config.artifactDir,
          availableModels: request.availableModels,
          parentModel: request.parentModel,
          runtime: request.runtime,
          runtimes,
          skillProjectionCache,
        }),
    );

    const settled = await runWithConcurrency(factories, concurrency, this.reportConcurrencyEvent);
    // `spawnOneChild` never rejects (it catches its own spawn failure into
    // an `{error}` outcome), so `runWithConcurrency` never sees a rejection
    // here - this unwrap is defensive, not a real branch.
    const outcomes = settled.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            agent: resolvedAgents[index]!.name,
            task: tasks[index]!.task ?? '',
            childIndex: index,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
    );

    return { outcomes };
  }
}
