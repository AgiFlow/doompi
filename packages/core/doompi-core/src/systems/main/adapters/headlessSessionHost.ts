import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Context as CordisContext } from '@deepseek-ai/cordis';
import { formatSkillsForSystemPrompt } from '@earendil-works/pi-agent-core';
import type { AgentHarnessResources, AgentHarnessTool, AgentMessage, HookMap } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { value } from '@earendil-works/pi-agent-core/harness/session';
import type { Model, Api, Usage } from '@earendil-works/pi-ai';
import {
  getAgentDir,
  ModelRuntime,
  loadProjectContextFiles,
  parseArgs,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type Args,
} from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { DOOM_CHILD_SESSION_SERVICE } from '../../../exports/childSession';
import type {
  DoomHeadlessEventName,
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '../../../exports/headless';
import type { DoomMcpSkill } from '../../../exports/mcpFacet';
import type { InstalledServerFacets } from '../../../exports/serverFacet';
import { createDirectHarnessRuntime } from '../../../server/directHarnessRuntime';
import { buildContextDetail } from '../../../services/contextDetail';
import { writeContextDetail } from '../../../services/contextDetailStore';
import { DOOM_CONTEXT_ENTRY_TYPE, projectContext } from '../../../services/contextProjection';
import { createHeadlessClient } from '../../../services/headlessClient';
import { createHistoryOwnership } from '../../../services/historyOwnership';
import {
  createPiExtensionHost,
  preloadPiExtensions,
  resolvePiExtensionEntries,
  type PiExtensionHost,
} from '../../../services/piExtensionHost';
import { formatToolPrompt, type ToolPromptEntry } from '../../../services/toolPrompt';
import type { ContextPromptStage } from '../../../types/contextApi';
import type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from '../../../types/server/directHarnessRuntime';
import type { SessionFrame } from '../../../types/server/session';
import type {
  SessionSkillDescriptor,
  SessionToolDescriptor,
  SessionToolSurface,
} from '../../../types/server/sessionToolSurface';
import { createHeadlessChildSessionServiceProvider } from '../../child/adapters/headlessChildSessionService';
import type { ResolvedHeadlessResource } from '../types/headlessHost';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../types/headlessSessionHost';
import { HeadlessHost, headlessHarnessSkill } from './headlessHost';

type AnyRecord = Record<string, unknown>;
type HeadlessTool = DoomHeadlessTool;
type AfterToolPatch = NonNullable<HookMap['after_tool']['result']>;
type ToolContent = NonNullable<AfterToolPatch['content']>;
type CompactResult = NonNullable<NonNullable<HookMap['before_compaction']['result']>['compaction']>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const EXTERNAL_OPERATION = 'external';

interface AppliedSessionTool {
  readonly descriptor: SessionToolDescriptor;
  execute(
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: Parameters<SessionToolSurface['invokeTool']>[0]['onUpdate'],
  ): Promise<import('../../../exports/headless').DoomHeadlessToolResult>;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

/** Restores the last accepted live selection from journal projections, falling back on launch configuration. */
export function restoreHeadlessSelection(
  entries: readonly AnyRecord[],
  fallback: DoomHeadlessSelection,
): DoomHeadlessSelection {
  let projected: Partial<DoomHeadlessSelection> | undefined;
  for (let index = entries.length - 1; index >= 0 && projected === undefined; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== 'custom' || !isRecord(entry.data)) continue;
    if (projected === undefined && entry.customType === DOOM_CONTEXT_ENTRY_TYPE) {
      const selection = entry.data.selection;
      if (!isRecord(selection) || typeof selection.majorMode !== 'string') continue;
      const domains = stringArray(selection.domains);
      if (domains === undefined || (selection.profile !== undefined && typeof selection.profile !== 'string')) continue;
      projected = {
        majorMode: selection.majorMode,
        domains,
        ...(typeof selection.profile === 'string' ? { profile: selection.profile } : {}),
      };
    }
  }
  return { ...fallback, ...projected };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isToolContent(value: unknown): value is ToolContent {
  return (
    Array.isArray(value) &&
    value.every((part) => {
      if (!isRecord(part)) return false;
      if (part.type === 'text') return typeof part.text === 'string';
      return part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string';
    })
  );
}

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  const cost = value.cost;
  return (
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
      (key) => typeof cost[key] === 'number' && Number.isFinite(cost[key]),
    )
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return false;
  if (value.role === 'user') return typeof value.content === 'string' || Array.isArray(value.content);
  if (!Array.isArray(value.content)) return false;
  if (value.role === 'assistant') {
    return (
      typeof value.api === 'string' &&
      typeof value.provider === 'string' &&
      typeof value.model === 'string' &&
      typeof value.stopReason === 'string' &&
      isUsage(value.usage)
    );
  }
  return (
    value.role === 'toolResult' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.isError === 'boolean'
  );
}

function isCompactResult(value: unknown): value is CompactResult {
  return (
    isRecord(value) &&
    typeof value.summary === 'string' &&
    typeof value.tokensBefore === 'number' &&
    Number.isFinite(value.tokensBefore) &&
    Array.isArray(value.retainedTail) &&
    value.retainedTail.every(isAgentMessage) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.details === undefined || isJsonValue(value.details))
  );
}

const unsupported = (parsed: Args): string | undefined => {
  const flags: Array<[string, unknown]> = [
    ['--help', parsed.help],
    ['--version', parsed.version],
    ['--mode', parsed.mode],
    ['--print', parsed.print],
    ['--export', parsed.export],
    ['--no-session', parsed.noSession],
    ['--continue', parsed.continue],
    ['--resume', parsed.resume],
    ['--fork', parsed.fork],
    ['--list-models', parsed.listModels],
    ['--offline', parsed.offline],
    ['--tui-mode', parsed.tuiMode],
    ['--extensions', parsed.extensions],
    ['--no-extensions', parsed.noExtensions],
    ['--skills', parsed.skills],
    ['--no-skills', parsed.noSkills],
    ['--prompt-templates', parsed.promptTemplates],
    ['--no-prompt-templates', parsed.noPromptTemplates],
    ['--themes', parsed.themes],
    ['--no-themes', parsed.noThemes],
    ['--no-context-files', parsed.noContextFiles],
    ['--tools', parsed.tools],
    ['--exclude-tools', parsed.excludeTools],
    ['--no-tools', parsed.noTools],
    ['--no-builtin-tools', parsed.noBuiltinTools],
    ['--project-trust-override', parsed.projectTrustOverride],
    ['--verbose', parsed.verbose],
  ];
  const match = flags.find(([, value]) => value !== undefined && value !== false);
  if (match) return `Direct headless mode does not support ${match[0]}.`;
  if (parsed.messages.length > 0 || parsed.fileArgs.length > 0)
    return 'Direct headless mode does not support positional prompts or files.';
  const unknown = parsed.unknownFlags.keys().next().value;
  return typeof unknown === 'string' ? `Direct headless mode does not support --${unknown}.` : undefined;
};

/** Validate the Pi flags that remain after Doom's harness flags are removed. */
export function validateDirectHeadlessArgs(agentArgs: readonly string[]): Args {
  const parsed = parseArgs([...agentArgs]);
  const diagnostics = parsed.diagnostics.filter((diagnostic) => diagnostic.type === 'error');
  if (diagnostics.length) throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  if (agentArgs.includes('--mode')) throw new Error('Direct headless mode does not support --mode.');
  const error = unsupported(parsed);
  if (error) throw new Error(error);
  return parsed;
}

function modelIdentity(model: Model<Api>): { provider: string; id: string } {
  return { provider: model.provider, id: model.id };
}

async function resolveModel(
  parsed: Args,
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
): Promise<{ model: Model<Api>; thinkingLevel?: Args['thinking'] }> {
  const cli = resolveCliModel({
    cliProvider: parsed.provider,
    cliModel: parsed.model,
    cliThinking: parsed.thinking,
    modelRuntime,
  });
  if (cli.error) throw new Error(cli.error);

  let scoped: Model<Api> | undefined;
  if (parsed.models !== undefined && parsed.models.length > 0) {
    const resolved = await resolveModelScopeWithDiagnostics(parsed.models, modelRuntime);
    scoped = resolved.scopedModels[0]?.model;
    if (scoped === undefined) throw new Error(`No configured model matched --models ${parsed.models.join(', ')}.`);
  }

  const configured =
    cli.model ??
    scoped ??
    (settings.getDefaultProvider() && settings.getDefaultModel()
      ? modelRuntime.getModel(settings.getDefaultProvider()!, settings.getDefaultModel()!)
      : undefined) ??
    (await modelRuntime.getAvailable())[0];
  if (configured === undefined) throw new Error('Direct headless mode could not resolve a configured model.');
  return {
    model: configured,
    thinkingLevel:
      cli.thinkingLevel ??
      parsed.thinking ??
      settings.getModelThinkingLevel(configured.provider, configured.id) ??
      settings.getDefaultThinkingLevel(),
  };
}

function mapResources(resources: readonly ResolvedHeadlessResource[]): {
  harness: AgentHarnessResources;
  context: string[];
  advertised: NonNullable<AgentHarnessResources['skills']>;
} {
  const skills: NonNullable<AgentHarnessResources['skills']> = [];
  const advertised: NonNullable<AgentHarnessResources['skills']> = [];
  const promptTemplates: NonNullable<AgentHarnessResources['promptTemplates']> = [];
  const context: string[] = [];
  for (const resource of resources) {
    if (resource.kind === 'skill') {
      const skill = headlessHarnessSkill(resource);
      skills.push(skill);
      // Advertised only with a path the agent can open. Without one the prompt would
      // point at a doom-headless:// URI no tool resolves, so such a skill stays
      // explicitly invocable and silent, exactly as it was before.
      if (resource.path !== undefined) advertised.push(skill);
    } else if (resource.kind === 'prompt') {
      promptTemplates.push({ name: resource.name, content: resource.text });
    } else {
      // Deliberately unwrapped. A generic "this is data, not instructions" fence here
      // would also wrap doompi/profile-config, which carries the operator's persona
      // and *is* authoritative instruction, and demoting it would be worse than the
      // anonymity it fixes. A resource whose body is untrusted owns its own boundary,
      // the way doompi-goal fences a user objective in escaped <goal_objective>.
      context.push(resource.text);
    }
  }
  return { harness: { skills, promptTemplates }, context, advertised };
}

function toolAdapter(
  tool: HeadlessTool,
  executionContext: () => DoomHeadlessExecutionContext,
  reportedErrors: Set<string>,
): AgentHarnessTool<object | undefined> {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
    ...(tool.executionMode === undefined
      ? {}
      : { executionMode: tool.executionMode === 'parallel' ? 'parallel' : 'sequential' }),
    async execute(toolCallId, parameters, onUpdate, _toolContext, _invocation, context) {
      const result = await tool.execute(
        toolCallId,
        parameters,
        context.abortSignal,
        (partial) => onUpdate({ content: partial.content, details: partial.details }),
        executionContext(),
      );
      if (result.isError === true) reportedErrors.add(toolCallId);
      return { content: result.content, details: result.details };
    },
  };
}

function eventHook(event: string): DoomHeadlessEventName | undefined {
  const hooks: Record<string, DoomHeadlessEventName> = {
    run_start: 'agent_start',
    run_resume: 'agent_start',
    run_end: 'agent_settled',
    turn_start: 'turn_start',
    turn_end: 'turn_end',
    message_start: 'message_start',
    message_update: 'message_update',
    message_end: 'message_end',
    tool_start: 'tool_execution_start',
    tool_update: 'tool_execution_update',
    tool_end: 'tool_execution_end',
    compaction_end: 'session_compact',
    navigation_end: 'session_tree',
  };
  return hooks[event];
}

function emitTo(listeners: Set<(frame: SessionFrame) => void>, frame: SessionFrame): void {
  // Observers added by a listener begin with the next frame.
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    try {
      listener(frame);
    } catch {
      // Compatibility listeners are observers.
    }
  }
}

/** The prompt a host has to show, and how complete it is. */
interface HeadlessSystemPrompt {
  readonly text: string;
  readonly stage: ContextPromptStage;
}

function createHeadlessCompositionPublisher(
  runtime: Pick<DirectHarnessRuntime, 'sessionId' | 'appendCustomEntry'>,
  host: HeadlessHost,
  environment: Readonly<Record<string, string | undefined>>,
  groups: (
    selection: DoomHeadlessSelection,
  ) => import('../../../services/contextProjection').ContextProjectionInput['groups'],
  readSystemPrompt: () => HeadlessSystemPrompt | undefined,
): (selection?: DoomHeadlessSelection) => Promise<void> {
  let countTokens: ((text: string) => number) | undefined;
  let contextRevision = 0;
  let publishedContext: string | undefined;
  // Publishes overlap: a selection settling and a turn building its prompt can
  // both ask at once, and each awaits the journal before recording what it
  // published. Run them one after another so the second sees the first's
  // revision rather than spending one of its own on the same composition.
  let tail: Promise<void> = Promise.resolve();

  const publish = async (selection: DoomHeadlessSelection): Promise<void> => {
    countTokens ??= (await import('gpt-tokenizer')).countTokens;
    const inventory = host.getContextInventory(selection, countTokens);
    const prompt = readSystemPrompt();
    const promptCost = prompt === undefined ? undefined : { tokens: countTokens(prompt.text), stage: prompt.stage };
    const context = projectContext({
      revision: contextRevision + 1,
      majorMode: selection.majorMode,
      ...(selection.profile === undefined ? {} : { profile: selection.profile }),
      groups: groups(selection),
      domains: selection.domains,
      sources: inventory.sources,
      skills: inventory.skills,
      attribution: inventory.attribution,
      countTokens,
      ...(promptCost === undefined ? {} : { systemPrompt: promptCost }),
    });
    // The prompt joins the key by its text, not just its figure: a reworded
    // prompt of the same length is a different answer to the reader's question.
    const contextKey = JSON.stringify({ ...context, revision: 0, promptText: prompt?.text });
    if (contextKey === publishedContext) return;
    const revision = contextRevision + 1;
    const details = buildContextDetail({
      sources: inventory.sources,
      skills: inventory.skills,
      countTokens,
      ...(prompt === undefined || promptCost === undefined
        ? {}
        : { systemPrompt: { text: prompt.text, tokens: promptCost.tokens, stage: prompt.stage } }),
    });
    await runtime.appendCustomEntry(DOOM_CONTEXT_ENTRY_TYPE, { ...context, revision });
    writeContextDetail(runtime.sessionId, revision, details, environment);
    contextRevision = revision;
    publishedContext = contextKey;
  };

  return (selection = host.context.selection): Promise<void> => {
    // A failed publish must not strand every publish that follows it.
    tail = tail.then(
      () => publish(selection),
      () => publish(selection),
    );
    return tail;
  };
}

/** Create the gated, same-process host used by direct-headless startup tests. */
export async function createHeadlessSessionHost(options: HeadlessSessionHostOptions): Promise<HeadlessSessionHost> {
  const parsed = validateDirectHeadlessArgs(options.agentArgs);
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(options.cwd, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  // Pi extensions load before the model is resolved: an extension that registers a provider
  // (a local Vertex or Bedrock bridge, say) must be in the runtime before the configured default
  // is looked up, or the lookup misses and the session silently falls back to whichever model
  // happens to be first in `getAvailable()`.
  const piPreload = await preloadPiExtensions({
    cwd: options.cwd,
    agentDir,
    models: modelRuntime,
    extensionPaths: options.piExtensions === false ? [] : resolvePiExtensionEntries(options.repoRoot),
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
  });
  const resolved = await resolveModel(parsed, modelRuntime, settings);
  if (parsed.apiKey !== undefined) await modelRuntime.setRuntimeApiKey(resolved.model.provider, parsed.apiKey);

  const reportedToolErrors = new Set<string>();
  let promptPreparationFailed = false;
  let headlessReady = false;
  // Guidance for the tools currently applied, refreshed by applyTools so a mode
  // switch adds and removes its tools' prompt text with the tools themselves.
  let toolGuidance: readonly ToolPromptEntry[] = [];
  const initialSystemPrompt = [parsed.systemPrompt, ...(parsed.appendSystemPrompt ?? [])].filter(Boolean).join('\n\n');
  /**
   * AGENTS.md and friends, in Pi's own framing.
   *
   * The server had none of this: its prompt began at the --system-prompt flag, so a
   * repository's own instructions reached a terminal session and never a cockpit one.
   * Mirrors @earendil-works/pi-coding-agent@0.85.1 dist/core/system-prompt.js:21-27
   * (the customPrompt branch, which is the shape this host matches). `buildSystemPrompt`
   * is not exported and the package exports map has no wildcard, so the four literals
   * below are copied; re-diff them against that file on upgrade.
   *
   * Not trust-gated, deliberately: TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES in Pi's
   * trust-manager covers settings.json, extensions, skills, prompts, themes, SYSTEM.md
   * and APPEND_SYSTEM.md, all of which execute or replace instructions. AGENTS.md is
   * advisory prose and Pi appends it unconditionally; gating it here would be a
   * divergence from Pi rather than parity with it.
   *
   * Resolved once: cwd is fixed for the host's lifetime, and composeSystemPrompt runs
   * on every generation.
   */
  const projectContextBlock = (() => {
    const files = loadProjectContextFiles({ cwd: options.cwd, agentDir });
    if (files.length === 0) return '';
    const instructions = files
      .map(
        ({ path: filePath, content }) =>
          `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n`,
      )
      .join('\n');
    return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${instructions}\n</project_context>`;
  })();
  const workingDirectoryLine = `Current working directory: ${options.cwd.replace(/\\/g, '/')}`;
  /**
   * Everything the prompt is made of before a package has had a say.
   *
   * Shared with the runtime callback below rather than copied. Assembling it is
   * pure; the hook pass that follows it there is not, which is why the context
   * panel is shown this rather than a prompt built for the panel's sake.
   */
  const composeSystemPrompt = (resources: readonly ResolvedHeadlessResource[]): string => {
    const mapped = mapResources(resources);
    // formatSkillsForSystemPrompt is the same renderer headlessHost already uses to
    // bill these skills to the context panel. Until now nothing emitted it, so the
    // panel charged for an <available_skills> block the model never received. It
    // returns '' for an empty list and leads with a blank line of its own.
    const skills = formatSkillsForSystemPrompt(mapped.advertised).trim();
    // Pi's order for the same sections: operator prompt, project context, tools,
    // skills, package context, then the working directory last.
    return [
      initialSystemPrompt,
      projectContextBlock,
      formatToolPrompt(toolGuidance),
      skills,
      ...mapped.context,
      workingDirectoryLine,
    ]
      .filter(Boolean)
      .join('\n\n');
  };
  /** The last prompt a turn actually built, once one has. */
  let builtSystemPrompt: string | undefined;
  /**
   * What the context panel is shown: the prompt a turn sent, or the hook-free
   * base until one has.
   *
   * The base is composed from the applied snapshot rather than a fresh read, so
   * it answers at exactly the moments the tool inventory beside it answers.
   * Re-reading refuses while a selection is mid-apply, and the panel would then
   * spend a published revision saying there is no prompt before the next one
   * said there is.
   */
  const readSystemPrompt = (): HeadlessSystemPrompt | undefined => {
    if (!headlessHost) return undefined;
    if (builtSystemPrompt !== undefined) return { text: builtSystemPrompt, stage: 'effective' };
    return { text: composeSystemPrompt(headlessHost.appliedResources), stage: 'base' };
  };
  const beforeTool: NonNullable<DirectHarnessRuntimeOptions['beforeTool']> = async (event) => {
    if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
    const patches = await headlessHost.dispatchHook('tool_call', event);
    let args = event.args;
    let block: NonNullable<HookMap['before_tool']['result']>['block'];
    for (const patch of patches) {
      if (!isRecord(patch)) continue;
      if (patch.args !== undefined) {
        if (!isJsonObject(patch.args)) throw new Error('Invalid headless tool arguments');
        args = patch.args as typeof args;
      }
      if (patch.block === undefined) continue;
      if (
        !isRecord(patch.block) ||
        typeof patch.block.reason !== 'string' ||
        (patch.block.terminate !== undefined && typeof patch.block.terminate !== 'boolean')
      ) {
        throw new Error('Invalid headless tool denial');
      }
      block = {
        reason: patch.block.reason,
        ...(typeof patch.block.terminate === 'boolean' ? { terminate: patch.block.terminate } : {}),
      };
      break;
    }
    return {
      ...(args === event.args ? {} : { args }),
      ...(block === undefined ? {} : { block }),
    };
  };
  const afterTool: NonNullable<DirectHarnessRuntimeOptions['afterTool']> = async (event) => {
    if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
    const reportedError = reportedToolErrors.delete(event.toolCallId);
    const original = reportedError ? { ...event, isError: true } : event;
    const patches = await headlessHost.dispatchHook('tool_result', original);
    let content = original.content;
    let details = original.details;
    let isError = original.isError;
    let usage = original.usage;
    let terminate: boolean | undefined;
    for (const patch of patches) {
      if (!isRecord(patch)) continue;
      if (isToolContent(patch.content)) content = patch.content;
      if ('details' in patch && isJsonValue(patch.details)) details = patch.details;
      if (typeof patch.isError === 'boolean') isError = patch.isError;
      if (isUsage(patch.usage)) usage = patch.usage;
      if (typeof patch.terminate === 'boolean') terminate = patch.terminate;
    }
    return {
      ...(content === event.content ? {} : { content }),
      ...(details === event.details ? {} : { details }),
      ...(isError === event.isError ? {} : { isError }),
      ...(usage === event.usage ? {} : { usage }),
      ...(terminate === undefined ? {} : { terminate }),
    };
  };
  const runtime = await createDirectHarnessRuntime({
    cwd: options.cwd,
    sessionId: options.sessionId,
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    storage: 'sqlite',
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
    sessionName: parsed.name ?? options.sessionName,
    ...(parsed.session === undefined ? {} : { sessionPath: parsed.session }),
    sessionsRoot: parsed.sessionDir ?? path.join(agentDir, 'server', 'sessions'),
    models: modelRuntime,
    model: resolved.model,
    ...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    beforeModelRequest: async ({ phase }) => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      if (phase === 'turn') await headlessHost.inheritSelection((await options.inheritedSelection?.()) ?? {});
    },
    transformContext: async (event) => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const patches = await headlessHost.dispatchHook('context', event);
      let messages = event.messages;
      let systemPrompt = event.systemPrompt;
      for (const patch of patches) {
        if (!isRecord(patch)) continue;
        if (patch.messages !== undefined) {
          if (!Array.isArray(patch.messages)) throw new Error('Invalid headless context messages');
          messages = patch.messages as typeof messages;
        }
        if (patch.systemPrompt !== undefined) {
          if (typeof patch.systemPrompt !== 'string') throw new Error('Invalid headless context system prompt');
          systemPrompt = patch.systemPrompt;
        }
      }
      // Pi extensions transform last, the same precedence the tool surface gives facets:
      // a facet name wins over a Pi name, so a Pi contribution is the outer layer.
      return { messages: await (piHost?.transformContext(messages) ?? messages), systemPrompt };
    },
    beforeTool,
    afterTool,
    beforePayload: async (event) => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const patches = await headlessHost.dispatchHook('before_provider_request', event);
      let payload = event.payload;
      for (const patch of patches) {
        if (patch === undefined || patch === null) continue;
        if (!isRecord(patch) || !('payload' in patch)) throw new Error('Invalid headless provider payload patch');
        payload = patch.payload;
      }
      return { payload };
    },
    beforeCompaction: async (event) => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const patches = await headlessHost.dispatchHook('session_before_compact', {
        reason: event.reason,
        preparation: event.preparation,
        ...(event.customInstructions === undefined
          ? {}
          : { instructions: event.customInstructions, customInstructions: event.customInstructions }),
      });
      try {
        for (const patch of patches) {
          if (patch === undefined || patch === null) continue;
          if (!isRecord(patch)) throw new Error('Invalid headless compaction patch');
          if (patch.cancel !== undefined && typeof patch.cancel !== 'boolean')
            throw new Error('Invalid headless compaction cancellation');
          if (patch.decline !== undefined && typeof patch.decline !== 'boolean')
            throw new Error('Invalid headless compaction decline');
          const decline = patch.cancel === true || patch.decline === true;
          if (decline && patch.compaction !== undefined) throw new Error('Conflicting headless compaction patch');
          if (decline) return { decline: true };
          if (patch.compaction !== undefined) {
            if (!isCompactResult(patch.compaction)) throw new Error('Invalid headless compaction result');
            return { compaction: patch.compaction };
          }
        }
      } catch (error) {
        options.onNotice?.(
          `Headless compaction hook rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { decline: true };
      }
      return piHost?.beforeCompaction(event);
    },
    systemPrompt: async () => {
      try {
        if (!headlessHost) throw new Error('Headless capabilities are not installed.');
        let prompt = composeSystemPrompt(await headlessHost.readResources());
        const patches = await headlessHost.dispatchHook('before_agent_start', { systemPrompt: prompt });
        for (const patch of patches) {
          if (patch && typeof patch === 'object' && 'systemPrompt' in patch && typeof patch.systemPrompt === 'string') {
            prompt = patch.systemPrompt;
          }
        }
        promptPreparationFailed = false;
        // The panel follows what was sent, so a prompt that changed mid-session
        // republishes rather than waiting for the next selection change. Awaited
        // here, on the same stage that already journals a selection inherited
        // for this turn, so the published composition and the prompt the model
        // receives cannot disagree. Its own guard: a journal that will not take
        // the entry is a panel that lags, never a turn that is refused.
        if (prompt !== builtSystemPrompt) {
          builtSystemPrompt = prompt;
          try {
            await publishComposition();
          } catch {
            // Reported by the next publish, which starts from the same state.
          }
        }
        return prompt;
      } catch {
        // A throwing system-prompt callback faults the upstream harness. Deny at model admission instead.
        promptPreparationFailed = true;
        return '';
      }
    },
    listCommands: () => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      return headlessHost.listCommands();
    },
    dispatchCommand: async (text) => {
      const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) return false;
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const name = match[1]!;
      const args = match[2] ?? '';
      if (!headlessHost.listCommands().some((entry) => entry.name === name)) return false;
      await headlessHost.dispatchCommand(name, args);
      return true;
    },
    guardModelRequest: () => {
      if (!headlessReady || promptPreparationFailed || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
    },
  });
  await runtime.session.setValue(value('doompi.session', 'workspaceRoot'), options.repoRoot, BACKGROUND_CONTEXT);

  let currentModel = await runtime.lane.getModel(BACKGROUND_CONTEXT);
  const entries = (
    await Promise.all(
      [DOOM_CONTEXT_ENTRY_TYPE].map((customType) =>
        runtime.lane.findEntries({ type: 'custom', customType, order: 'newestFirst', limit: 1 }, BACKGROUND_CONTEXT),
      ),
    )
  ).flat() as unknown as AnyRecord[];
  const listeners = new Set<(frame: SessionFrame) => void>();
  const initialSelection = restoreHeadlessSelection(entries, options.selection);
  let headlessHost: HeadlessHost | undefined;
  let mcpServiceRoot: CordisContext | undefined;
  let mcpLifecycle = new AbortController();
  let piHost: PiExtensionHost | undefined;
  let client: ReturnType<typeof createHeadlessClient> | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let publishComposition: (selection?: DoomHeadlessSelection) => Promise<void> = async () => {
    throw new Error('Direct headless composition publisher is not installed.');
  };
  const childSessionProvider = createHeadlessChildSessionServiceProvider({
    parentSessionId: runtime.sessionId,
    cwd: options.cwd,
    sessionsRoot: parsed.sessionDir ?? path.join(agentDir, 'server', 'sessions'),
    models: modelRuntime,
    defaultModel: () => currentModel,
  });

  const executionContext = (selection: DoomHeadlessSelection): DoomHeadlessExecutionContext => ({
    cwd: options.cwd,
    repoRoot: options.repoRoot,
    sessionId: runtime.sessionId,
    environment: options.environment,
    client: client!.client,
    model: currentModel === undefined ? undefined : modelIdentity(currentModel),
    selection,
    textCompletion: {
      available(reference) {
        const separator = reference.indexOf('/');
        return (
          separator > 0 &&
          !!modelRuntime.getModel(reference.slice(0, separator), reference.slice(separator + 1)) &&
          modelRuntime.hasConfiguredAuth(reference.slice(0, separator))
        );
      },
      async complete(reference, request) {
        if (disposed || !headlessReady || promptPreparationFailed || !headlessHost?.status.ready)
          throw new Error('Headless capability preparation is not ready.');
        const separator = reference.indexOf('/');
        const model =
          separator > 0
            ? modelRuntime.getModel(reference.slice(0, separator), reference.slice(separator + 1))
            : undefined;
        if (!model || !modelRuntime.hasConfiguredAuth(model.provider))
          throw new Error(`Model is not configured: ${reference}`);
        if (!runtime.completeModel) throw new Error('The runtime does not support auxiliary model requests.');
        const response = await runtime.completeModel(
          model,
          {
            systemPrompt: request.systemPrompt,
            messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
          },
          {
            signal: request.signal,
            maxTokens: request.maxTokens,
            cacheRetention: request.cacheRetention,
            reasoningEffort: 'none',
            maxRetries: 0,
          },
        );
        if (response.stopReason === 'error' || response.stopReason === 'aborted')
          throw new Error(response.errorMessage ?? `Model stopped: ${response.stopReason}`);
        return response.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
          .trim();
      },
    },
    session: {
      async readModelSettings() {
        const model = await runtime.lane.getModel(BACKGROUND_CONTEXT);
        const thinkingLevel = await runtime.lane.getThinkingLevel(BACKGROUND_CONTEXT);
        return { ...(model ? { model: modelIdentity(model) } : {}), thinkingLevel };
      },
      async setModelSettings(settings) {
        if (settings.model) await runtime.setModel(settings.model);
        if (settings.thinkingLevel !== undefined) await runtime.setThinkingLevel(settings.thinkingLevel);
      },
      async forkSource() {
        const metadata = runtime.session.metadata as unknown as { path?: unknown };
        if (typeof metadata.path !== 'string') throw new Error('The parent session has no persisted journal.');
        const { leafId } = await runtime.readEntries();
        return {
          kind: 'v4-fork' as const,
          sessionFile: metadata.path,
          branch: runtime.laneName,
          ...(leafId === null ? {} : { entryId: leafId }),
        };
      },
      entries: async (query) =>
        (await runtime.lane.findEntries(
          { ...query, order: query?.limit === undefined ? 'oldestFirst' : 'newestFirst' },
          BACKGROUND_CONTEXT,
        )) as unknown as AnyRecord[],
      async appendCustomEntry(type, data) {
        await runtime.appendCustomEntry(type, data);
      },
      prompt: (text, delivery) =>
        delivery === 'steer'
          ? runtime.steer(text)
          : delivery === 'followUp'
            ? runtime.followUp(text)
            : runtime.prompt(text),
      async admitPrompt(text, delivery) {
        // followUp stays enqueue-only: voiceServer/index.ts:120 asks for 'followUp' while the agent
        // is idle whenever a capture is queued, and waking a turn there would be unrequested.
        if (delivery === 'followUp') return runtime.followUp(text);
        const submission = await runtime.submitPrompt(text, undefined, delivery === 'steer' ? 'steer' : undefined);
        void submission.settled.catch((error: unknown) =>
          client!.client.notify({ body: error instanceof Error ? error.message : String(error), level: 'error' }),
        );
      },
      abort: () => runtime.abort(),
      compact: (instructions) => runtime.compact(instructions),
      async activity() {
        const state = await runtime.readState();
        return {
          hasPendingMessages: Number(state.pendingMessageCount) > 0,
          isIdle: !state.isStreaming && !state.isCompacting,
        };
      },
    },
    shutdown: () => stop(),
  });

  client = createHeadlessClient({
    appendCustomEntry: async (type, data) => {
      await runtime.appendCustomEntry(type, data);
    },
    emitFrame: (frame) => emitTo(listeners, frame),
  });

  const unsubscribePresentation = runtime.onPresentationFrame((frame) => emitTo(listeners, frame));
  const unsubscribeEvents = runtime.onEvent(async (event, _context) => {
    if (event.type === 'config_update' && event.property === 'model') {
      currentModel = await runtime.lane.getModel(BACKGROUND_CONTEXT);
      if (headlessHost !== undefined && currentModel !== undefined && headlessHost.status.ready) {
        await headlessHost.dispatchHook('model_select', { model: currentModel });
      }
    }
    const hook = eventHook(event.type);
    if (headlessHost !== undefined && hook !== undefined && headlessHost.status.ready)
      await headlessHost.dispatchHook(hook, event as unknown as AnyRecord);
  });

  // The facet tools from the most recent reconciliation. Kept so a Pi-side restriction change can
  // rebuild the merged surface in memory, the same way the kernel's tools sink does, instead of
  // forcing a session reload.
  let appliedFacetTools: readonly HeadlessTool[] = [];
  let appliedSessionTools = new Map<string, AppliedSessionTool>();
  let appliedSkills = new Map<string, { descriptor: SessionSkillDescriptor; content: string }>();
  let surfaceRevision = 0;
  let toolSurfaceReady = false;
  let toolReapplyQueued = false;
  let mcpSurfaceRevision = 0;
  let mcpSurfaceReady = false;
  let appliedMcpTools = new Map<string, AppliedSessionTool>();
  let appliedMcpSkills = new Map<string, { descriptor: SessionSkillDescriptor; skill: DoomMcpSkill }>();

  const prepareMcpSurface = async (): Promise<void> => {
    if (!headlessHost?.status.ready) throw new Error('Headless capabilities are not installed.');
    if (mcpServiceRoot === undefined) throw new Error('MCP session services are not installed.');
    mcpSurfaceReady = false;
    mcpLifecycle.abort();
    mcpLifecycle = new AbortController();
    const pluginContext = {
      execution: headlessHost.context,
      services: { get: <T>(name: string): T | undefined => mcpServiceRoot?.get(name) as T | undefined },
      selection: {
        read: () => headlessHost!.context.selection,
        change: (change: Parameters<HeadlessHost['changeSelection']>[0]) => headlessHost!.changeSelection(change),
      },
      signal: mcpLifecycle.signal,
    };
    const nextTools = new Map<string, AppliedSessionTool>();
    const nextSkills = new Map<string, { descriptor: SessionSkillDescriptor; skill: DoomMcpSkill }>();
    for (const loaded of options.mcpPlugins ?? []) {
      const selection = headlessHost.context.selection;
      if (
        !loaded.declaration.owners.some(
          (owner) =>
            owner.majorMode === selection.majorMode &&
            (owner.layer === 'default' || selection.activeLayers.includes(owner.layer)),
        )
      )
        continue;
      const scope =
        typeof loaded.plugin.session === 'function'
          ? await loaded.plugin.session(pluginContext)
          : loaded.plugin.session;
      for (const tool of scope.tools ?? []) {
        if (nextTools.has(tool.name)) throw new Error(`Duplicate MCP tool '${tool.name}'`);
        nextTools.set(tool.name, {
          descriptor: {
            name: tool.name,
            label: tool.label ?? tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
          execute: (toolCallId, parameters, signal, onUpdate) =>
            tool.execute(toolCallId, parameters, signal, onUpdate, headlessHost!.context),
        });
      }
      for (const skill of scope.skills ?? []) {
        if ([...nextSkills.values()].some((candidate) => candidate.descriptor.name === skill.name))
          throw new Error(`Duplicate MCP skill '${skill.name}'`);
        const uri = `doompi://session/${encodeURIComponent(runtime.sessionId)}/mcp/skills/${encodeURIComponent(skill.name)}`;
        nextSkills.set(uri, {
          descriptor: { name: skill.name, description: skill.description, uri },
          skill,
        });
      }
    }
    appliedMcpTools = nextTools;
    appliedMcpSkills = nextSkills;
    mcpSurfaceRevision += 1;
    mcpSurfaceReady = true;
  };

  const applyToolSurface = async (tools: readonly HeadlessTool[]): Promise<void> => {
    toolSurfaceReady = false;
    const facetTools = tools.map((tool) => toolAdapter(tool, () => headlessHost!.context, reportedToolErrors));
    // Facet tools win a name collision, including when the collision is with a
    // name the facet surface declared and then gated out. The reconciled set
    // owns the name either way, so a Pi extension tool never fills a slot a
    // mode-aware facet deliberately left empty.
    const facetNames = headlessHost?.declaredToolNames ?? new Set(facetTools.map((tool) => tool.name));
    const piTools = (piHost?.tools ?? []).filter((tool) => !facetNames.has(tool.name));
    const nextToolGuidance = [
      ...(piHost?.toolGuidance ?? []).filter((entry) => !facetNames.has(entry.name)),
      ...tools.map((tool) => ({
        name: tool.name,
        ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
        ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
      })),
    ];
    await runtime.replaceTools([...piTools, ...facetTools]);
    const next = new Map<string, AppliedSessionTool>();
    for (const tool of piTools) {
      next.set(tool.name, {
        descriptor: {
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        execute: (toolCallId, parameters, signal, onUpdate) =>
          piHost!.executeTool(tool.name, toolCallId, parameters, signal, onUpdate),
      });
    }
    for (const tool of tools) {
      next.set(tool.name, {
        descriptor: {
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        execute: (toolCallId, parameters, signal, onUpdate) =>
          tool.execute(toolCallId, parameters, signal, onUpdate, headlessHost!.context),
      });
    }
    toolGuidance = nextToolGuidance;
    appliedSessionTools = next;
    surfaceRevision += 1;
    toolSurfaceReady = true;
  };

  /**
   * Rebuilds the merged tool surface after a Pi extension narrowed its own tools.
   *
   * Deferred because the tool surface arbiter calls `setActiveTools` synchronously from inside
   * `register`, and coalesced because several extensions register their restrictions in the same
   * tick. The facet set is unchanged, so this never re-enters the kernel.
   */
  const scheduleToolReapply = (): void => {
    if (toolReapplyQueued) return;
    toolReapplyQueued = true;
    queueMicrotask(() => {
      toolReapplyQueued = false;
      void applyToolSurface(appliedFacetTools).catch((error: unknown) =>
        options.onNotice?.(
          `Pi extension tool refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  };

  const prepareFacets = (root: CordisContext): void => {
    mcpServiceRoot = root;
    root.plugin((context) => {
      context.provide(DOOM_CHILD_SESSION_SERVICE, childSessionProvider.get());
      context.effect(() => () => childSessionProvider.close(), 'headless child session service lifetime');
    });
    if (headlessHost !== undefined) throw new Error('Direct headless facets were prepared more than once.');
    if (piPreload !== undefined) {
      piHost = createPiExtensionHost({
        cwd: options.cwd,
        agentDir,
        models: modelRuntime,
        runtime,
        preload: piPreload,
        getModel: () => currentModel,
        getThinkingLevel: () => resolved.thinkingLevel ?? 'off',
        client: () => client?.client,
        onActiveToolsChanged: scheduleToolReapply,
        ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
      });
    }
    headlessHost = new HeadlessHost(root, {
      candidates: options.candidates,
      selection: initialSelection,
      selectionOverrides: [
        ...new Set([
          ...(options.selectionOverrides ?? []),
          ...(['majorMode', 'domains', 'profile'] as const).filter(
            (axis) => JSON.stringify(initialSelection[axis]) !== JSON.stringify(options.selection[axis]),
          ),
        ]),
      ],
      context: executionContext,
      resolveSelection: options.resolveSelection,
      applyTools: async (tools) => {
        appliedFacetTools = tools;
        await applyToolSurface(tools);
      },
      applyResources: async (next) => {
        const mapped = mapResources(next);
        // Facet skills win a name collision, for the same reason facet tools do.
        const facetNames = new Set((mapped.harness.skills ?? []).map((skill) => skill.name));
        const piSkills = (piHost?.skills ?? []).filter((skill) => !facetNames.has(skill.name));
        const mergedSkills = [...piSkills, ...(mapped.harness.skills ?? [])];
        await runtime.replaceResources(
          piSkills.length === 0 ? mapped.harness : { ...mapped.harness, skills: mergedSkills },
        );
        appliedSkills = new Map(
          mergedSkills.map((skill) => {
            const uri = `doompi://session/${encodeURIComponent(runtime.sessionId)}/skills/${encodeURIComponent(skill.name)}`;
            return [
              uri,
              {
                descriptor: { name: skill.name, description: skill.description, uri },
                content: skill.content,
              },
            ];
          }),
        );
        surfaceRevision += 1;
      },
      onApplied: async (selection) => {
        options.publishSelectionStatus?.((source, text) => client!.client.setStatus(source, text), selection);
      },
      onError: (error) =>
        options.onNotice?.(`Headless selection failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    publishComposition = createHeadlessCompositionPublisher(
      runtime,
      headlessHost,
      options.environment,
      (selection) => options.contextGroups?.(root, selection) ?? [],
      readSystemPrompt,
    );
    headlessHost.subscribeSelection(async (selection) => {
      // `onApplied` runs before HeadlessHost publishes its ready snapshot. Recompose
      // the remote surface here, after selection is coherent, rather than making a
      // transient not-ready state fail the host selection.
      if (!headlessReady) return;
      await prepareMcpSurface();
      await publishComposition(selection);
    });
  };

  const activateFacets = async (installed: InstalledServerFacets): Promise<void> => {
    if (headlessHost === undefined) throw new Error('Direct headless host was not prepared.');
    headlessHost.setAvailableSources(installed.installedPackages);
    // Pi extensions load before the first selection so their session lifetime tools and skills
    // are present in the very first composition. A failure here is reported, never fatal.
    if (piHost !== undefined) {
      try {
        await piHost.load();
      } catch (error) {
        options.onNotice?.(`Pi extensions failed to load: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await headlessHost.select(initialSelection);
    headlessReady = headlessHost.status.ready;
    if (headlessReady) {
      await prepareMcpSurface();
      await headlessHost.dispatchHook('session_start', {});
      await publishComposition();
      // A journal reopened while its lane still holds an in-flight operation is a
      // turn that was cut off, not a finished one. Driving it here is what the
      // runtime's resume exists for, and it runs detached because that turn can
      // outlive session startup by minutes.
      void runtime
        .resume()
        .catch((error: unknown) =>
          options.onNotice?.(`Session resume failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
  };

  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      if (disposed) return;
      disposed = true;
      headlessReady = false;
      mcpSurfaceReady = false;
      mcpLifecycle.abort();
      const failures: unknown[] = [];
      try {
        if (headlessHost?.status.ready) await headlessHost.dispatchHook('session_shutdown', {});
      } catch (error) {
        failures.push(error);
      }
      try {
        await piHost?.shutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        await headlessHost?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await childSessionProvider.close();
      } catch (error) {
        failures.push(error);
      }
      client?.dispose();
      unsubscribePresentation();
      unsubscribeEvents();
      try {
        await runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, 'Headless session shutdown failed');
    })();
    return disposePromise;
  };
  const stop = (): void => {
    void dispose().catch((error: unknown) =>
      options.onNotice?.(error instanceof Error ? error.message : String(error)),
    );
  };

  const invokeSurfaceTool = async (
    invocation: Parameters<SessionToolSurface['invokeTool']>[0],
    readRevision: () => number,
    readTools: () => Map<string, AppliedSessionTool>,
    ready: () => boolean,
    lifecycleSignal?: AbortSignal,
  ): Promise<import('../../../exports/headless').DoomHeadlessToolResult> => {
    if (disposed || !headlessReady || !ready() || !headlessHost?.status.ready)
      throw new Error('Headless capability preparation is not ready.');
    if (invocation.revision !== readRevision()) throw new Error('The session tool surface has changed');
    if (!isJsonObject(invocation.arguments)) throw new Error('Tool arguments must be a JSON object');
    const applied = readTools().get(invocation.name);
    if (applied === undefined) throw new Error(`Tool '${invocation.name}' is not active`);
    if (!Value.Check(applied.descriptor.parameters, invocation.arguments))
      throw new Error(`Invalid arguments for tool '${invocation.name}'`);
    const signals = [invocation.signal, lifecycleSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    signal?.throwIfAborted();
    return runtime.runExternalOperation(async () => {
      const toolCallId = `external-${randomUUID()}`;
      const before = await beforeTool(
        { toolCallId, toolName: invocation.name, args: invocation.arguments as Record<string, JsonValue> },
        BACKGROUND_CONTEXT,
      );
      if (before?.block !== undefined) return { content: [{ type: 'text', text: before.block.reason }], isError: true };
      const args = before?.args ?? (invocation.arguments as Record<string, JsonValue>);
      if (!Value.Check(applied.descriptor.parameters, args))
        throw new Error(`A tool hook produced invalid arguments for '${invocation.name}'`);
      await invocation.authorize?.();
      signal?.throwIfAborted();
      if (disposed || !headlessReady || !ready() || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
      if (invocation.revision !== readRevision() || readTools().get(invocation.name) !== applied)
        throw new Error(`Tool '${invocation.name}' is no longer active`);
      emitTo(listeners, {
        type: 'tool_execution_start',
        runId: EXTERNAL_OPERATION,
        turnId: EXTERNAL_OPERATION,
        toolCallId,
        toolName: invocation.name,
        args,
      });
      let result;
      try {
        result = await applied.execute(toolCallId, args, signal, (partial) => {
          emitTo(listeners, {
            type: 'tool_execution_update',
            runId: EXTERNAL_OPERATION,
            turnId: EXTERNAL_OPERATION,
            toolCallId,
            toolName: invocation.name,
            partialResult: partial,
          });
          invocation.onUpdate?.(partial);
        });
      } catch (error) {
        result = {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
      const patch = await afterTool(
        {
          toolCallId,
          toolName: invocation.name,
          args,
          content: result.content,
          ...(isJsonValue(result.details) ? { details: result.details } : {}),
          isError: result.isError === true,
        },
        BACKGROUND_CONTEXT,
      );
      const patched = {
        content: patch?.content ?? result.content,
        ...(patch?.details !== undefined
          ? { details: patch.details }
          : result.details === undefined
            ? {}
            : { details: result.details }),
        isError: patch?.isError ?? result.isError ?? false,
      };
      emitTo(listeners, {
        type: 'tool_execution_end',
        runId: EXTERNAL_OPERATION,
        turnId: EXTERNAL_OPERATION,
        toolCallId,
        toolName: invocation.name,
        result: patched,
        isError: patched.isError,
        terminate: patch?.terminate ?? false,
      });
      return patched;
    });
  };

  const toolSurface: SessionToolSurface = {
    readSurface() {
      if (disposed || !headlessReady || !toolSurfaceReady || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
      return {
        revision: surfaceRevision,
        tools: [...appliedSessionTools.values()].map((tool) => tool.descriptor),
        skills: [...appliedSkills.values()].map((skill) => skill.descriptor),
      };
    },
    invokeTool: (invocation) =>
      invokeSurfaceTool(
        invocation,
        () => surfaceRevision,
        () => appliedSessionTools,
        () => toolSurfaceReady,
      ),
    readSkill(revision, uri) {
      if (disposed || !headlessReady || !toolSurfaceReady || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
      if (revision !== surfaceRevision) throw new Error('The session skill surface has changed');
      const skill = appliedSkills.get(uri);
      if (skill === undefined) throw new Error('The session skill is not active');
      return skill.content;
    },
  };

  const mcpSurface: SessionToolSurface = {
    readSurface() {
      if (disposed || !headlessReady || !mcpSurfaceReady || !headlessHost?.status.ready)
        throw new Error('MCP capability preparation is not ready.');
      return {
        revision: mcpSurfaceRevision,
        tools: [...appliedMcpTools.values()].map((tool) => tool.descriptor),
        skills: [...appliedMcpSkills.values()].map((skill) => skill.descriptor),
      };
    },
    invokeTool: (invocation) =>
      invokeSurfaceTool(
        invocation,
        () => mcpSurfaceRevision,
        () => appliedMcpTools,
        () => mcpSurfaceReady,
        mcpLifecycle.signal,
      ),
    async readSkill(revision, uri) {
      if (disposed || !headlessReady || !mcpSurfaceReady || !headlessHost?.status.ready)
        throw new Error('MCP capability preparation is not ready.');
      if (revision !== mcpSurfaceRevision) throw new Error('The session MCP surface has changed');
      const skill = appliedMcpSkills.get(uri)?.skill;
      if (skill === undefined) throw new Error('The session MCP skill is not active');
      const text = await skill.read(headlessHost.context);
      if (disposed || !headlessReady || !mcpSurfaceReady || !headlessHost?.status.ready)
        throw new Error('MCP capability preparation is not ready.');
      if (revision !== mcpSurfaceRevision || appliedMcpSkills.get(uri)?.skill !== skill)
        throw new Error('The session MCP surface has changed');
      return text;
    },
  };

  return {
    runtime,
    get host() {
      return headlessHost;
    },
    toolSurface,
    mcpSurface,
    prepareFacets,
    activateFacets,
    canDispatch: () => !disposed && headlessReady && !promptPreparationFailed && headlessHost?.status.ready === true,
    onPresentationFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respondToExtensionUi(frame) {
      return client?.receive(frame as SessionFrame) ?? false;
    },
    dispose,
  };
}
