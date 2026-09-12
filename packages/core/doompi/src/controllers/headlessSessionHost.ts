import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type { InstalledServerFacets } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { DOOM_MINOR_MODE_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/mode';
import type {
  DoomHeadlessEventName,
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_CHILD_SESSION_SERVICE } from '@agimon-ai/doompi-extension-contracts/child-session';
import { domainStatus } from '@agimon-ai/doompi-domain';
import { statusText } from '@agimon-ai/doompi-major-mode';
import { createHeadlessClient } from '../services/headlessClient';
import { HeadlessHost, headlessHarnessSkill } from './headlessHost';
import { createDirectHarnessRuntime } from './directHarnessRuntime';
import { createHeadlessChildSessionServiceProvider } from './headlessChildSessionService';
import { createHistoryOwnership } from '../services/historyOwnership';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../types/server/headlessSessionHost';
import type { SessionFrame } from '../types/server/session';
import type { ResolvedHeadlessResource } from '../types/server/headlessHost';
import type { DirectHarnessRuntime } from '../types/server/directHarnessRuntime';
import { buildContextDetail } from '../services/contextDetail';
import { DOOM_CONTEXT_ENTRY_TYPE, projectContext } from '../services/contextProjection';
import { projectMinorModes } from '../services/minorModeProjection';
import {
  executeMinorModeCommand,
  MINOR_MODE_COMMAND,
  MINOR_MODE_COMMAND_DESCRIPTION,
} from '../services/minorModeCommand';
import { writeContextDetail } from '../services/contextDetailStore';
import {
  getAgentDir,
  ModelRuntime,
  parseArgs,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type Args,
} from '@earendil-works/pi-coding-agent';
import { counter } from '@agimon-ai/doompi-skill/catalog';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { AgentHarnessResources, AgentHarnessTool, AgentMessage, HookMap } from '@earendil-works/pi-agent-core';
import type { Model, Api, Usage } from '@earendil-works/pi-ai';
import path from 'node:path';

type AnyRecord = Record<string, unknown>;
type HeadlessTool = DoomHeadlessTool;
type AfterToolPatch = NonNullable<HookMap['after_tool']['result']>;
type ToolContent = NonNullable<AfterToolPatch['content']>;
type CompactResult = NonNullable<NonNullable<HookMap['before_compaction']['result']>['compaction']>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  let minorModes: string[] | undefined;
  for (
    let index = entries.length - 1;
    index >= 0 && (projected === undefined || minorModes === undefined);
    index -= 1
  ) {
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
    if (
      minorModes === undefined &&
      entry.customType === DOOM_MINOR_MODE_ENTRY_TYPE &&
      Array.isArray(entry.data.modes)
    ) {
      minorModes = entry.data.modes
        .filter((mode): mode is AnyRecord => isRecord(mode))
        .filter((mode) => mode.activation === 'active' && typeof mode.id === 'string')
        .map((mode) => mode.id as string);
    }
  }
  return { ...fallback, ...projected, minorModes: minorModes ?? fallback.minorModes };
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
} {
  const skills: NonNullable<AgentHarnessResources['skills']> = [];
  const promptTemplates: NonNullable<AgentHarnessResources['promptTemplates']> = [];
  const context: string[] = [];
  for (const resource of resources) {
    if (resource.kind === 'skill') {
      skills.push(headlessHarnessSkill(resource));
    } else if (resource.kind === 'prompt') {
      promptTemplates.push({ name: resource.name, content: resource.text });
    } else {
      context.push(resource.text);
    }
  }
  return { harness: { skills, promptTemplates }, context };
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

function publishHeadlessSelectionStatus(
  setStatus: (source: string, text: string | undefined) => void,
  selection: DoomHeadlessSelection,
): void {
  setStatus('doom-major-mode', statusText(selection.majorMode, selection.domains, selection.profile));
  setStatus('doom-domain', domainStatus(selection.domains));
  setStatus('doom-profile', selection.profile);
}

function createHeadlessCompositionPublisher(
  runtime: Pick<DirectHarnessRuntime, 'sessionId' | 'appendCustomEntry'>,
  host: HeadlessHost,
  environment: Readonly<Record<string, string | undefined>>,
): (selection?: DoomHeadlessSelection) => Promise<void> {
  let countTokens: ((text: string) => number) | undefined;
  let contextRevision = 0;
  let publishedContext: string | undefined;
  let publishedMinorModes: string | undefined;

  return async (selection = host.context.selection): Promise<void> => {
    countTokens ??= await counter();
    const inventory = host.getContextInventory(selection, countTokens);
    const snapshot = host.catalog.getSnapshot();
    const minorModeLabels = new Map(snapshot.modes.map(({ descriptor }) => [descriptor.id, descriptor.label]));
    const minorModes = selection.minorModes.flatMap((id) => {
      const label = minorModeLabels.get(id);
      return label === undefined ? [] : [{ id, label }];
    });
    const context = projectContext({
      revision: contextRevision + 1,
      majorMode: selection.majorMode,
      ...(selection.profile === undefined ? {} : { profile: selection.profile }),
      minorModes,
      domains: selection.domains,
      sources: inventory.sources,
      skills: inventory.skills,
      attribution: inventory.attribution,
      countTokens,
    });
    const contextKey = JSON.stringify({ ...context, revision: 0 });
    if (contextKey !== publishedContext) {
      const revision = contextRevision + 1;
      const details = buildContextDetail({
        sources: inventory.sources,
        skills: inventory.skills,
        countTokens,
      });
      await runtime.appendCustomEntry(DOOM_CONTEXT_ENTRY_TYPE, { ...context, revision });
      writeContextDetail(runtime.sessionId, revision, details, environment);
      contextRevision = revision;
      publishedContext = contextKey;
    }

    const minorProjection = projectMinorModes(snapshot, 'headless');
    const minorKey = JSON.stringify(minorProjection);
    if (minorKey === publishedMinorModes) return;
    await runtime.appendCustomEntry(DOOM_MINOR_MODE_ENTRY_TYPE, minorProjection);
    publishedMinorModes = minorKey;
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
  const resolved = await resolveModel(parsed, modelRuntime, settings);
  if (parsed.apiKey !== undefined) await modelRuntime.setRuntimeApiKey(resolved.model.provider, parsed.apiKey);

  const reportedToolErrors = new Set<string>();
  let promptPreparationFailed = false;
  let headlessReady = false;
  const initialSystemPrompt = [parsed.systemPrompt, ...(parsed.appendSystemPrompt ?? [])].filter(Boolean).join('\n\n');
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
      return { messages, systemPrompt };
    },
    beforeTool: async (event) => {
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
    },
    afterTool: async (event) => {
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
    },
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
      return undefined;
    },
    systemPrompt: async () => {
      try {
        if (!headlessHost) throw new Error('Headless capabilities are not installed.');
        const resources = await headlessHost.readResources();
        let prompt = [initialSystemPrompt, ...mapResources(resources).context].filter(Boolean).join('\n\n');
        const patches = await headlessHost.dispatchHook('before_agent_start', { systemPrompt: prompt });
        for (const patch of patches) {
          if (patch && typeof patch === 'object' && 'systemPrompt' in patch && typeof patch.systemPrompt === 'string') {
            prompt = patch.systemPrompt;
          }
        }
        promptPreparationFailed = false;
        return prompt;
      } catch {
        // A throwing system-prompt callback faults the upstream harness. Deny at model admission instead.
        promptPreparationFailed = true;
        return '';
      }
    },
    listCommands: () => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const commands = headlessHost.listCommands();
      return commands.some(({ name }) => name === MINOR_MODE_COMMAND)
        ? commands
        : [...commands, { name: MINOR_MODE_COMMAND, description: MINOR_MODE_COMMAND_DESCRIPTION }];
    },
    dispatchCommand: async (text) => {
      const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) return false;
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      const name = match[1]!;
      const args = match[2] ?? '';
      if (name === MINOR_MODE_COMMAND) {
        const executionClient = headlessHost.context.client;
        await executeMinorModeCommand(args, {
          catalog: headlessHost.catalog,
          kind: 'headless',
          ui: {
            async select(title, options) {
              const selected = await executionClient.request({
                kind: 'select',
                title,
                options: options.map((label) => ({ label, value: label })),
              });
              return typeof selected === 'string' ? selected : undefined;
            },
            async input(title, message) {
              const entered = await executionClient.request({ kind: 'input', title, message });
              return typeof entered === 'string' ? entered : undefined;
            },
            async confirm(title, message) {
              const confirmed = await executionClient.request({ kind: 'confirm', title, message });
              return typeof confirmed === 'boolean' ? confirmed : undefined;
            },
            notify: (message, level) => executionClient.notify({ body: message, level }),
          },
        });
        return true;
      }
      if (!headlessHost.listCommands().some((entry) => entry.name === name)) return false;
      await headlessHost.dispatchCommand(name, args);
      return true;
    },
    guardModelRequest: () => {
      if (!headlessReady || promptPreparationFailed || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
    },
  });

  let currentModel = await runtime.lane.getModel(BACKGROUND_CONTEXT);
  const entries = (
    await Promise.all(
      [DOOM_CONTEXT_ENTRY_TYPE, DOOM_MINOR_MODE_ENTRY_TYPE].map((customType) =>
        runtime.lane.findEntries({ type: 'custom', customType, order: 'newestFirst', limit: 1 }, BACKGROUND_CONTEXT),
      ),
    )
  ).flat() as unknown as AnyRecord[];
  const listeners = new Set<(frame: SessionFrame) => void>();
  const initialSelection = restoreHeadlessSelection(entries, options.selection);
  let headlessHost: HeadlessHost | undefined;
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
    session: {
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

  const prepareFacets = (root: CordisContext): void => {
    root.plugin((context) => {
      context.provide(DOOM_CHILD_SESSION_SERVICE, childSessionProvider.get());
      context.effect(() => () => childSessionProvider.close(), 'headless child session service lifetime');
    });
    if (headlessHost !== undefined) throw new Error('Direct headless facets were prepared more than once.');
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
      applyTools: async (tools) =>
        runtime.replaceTools(tools.map((tool) => toolAdapter(tool, () => headlessHost!.context, reportedToolErrors))),
      applyResources: async (next) => {
        const mapped = mapResources(next);
        await runtime.replaceResources(mapped.harness);
      },
      onApplied: async (selection) => {
        if (headlessReady) await publishComposition(selection);
        publishHeadlessSelectionStatus((source, text) => client!.client.setStatus(source, text), selection);
      },
      onMinorModeChanged: () => publishComposition(),
      onError: (error) =>
        options.onNotice?.(`Headless selection failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    publishComposition = createHeadlessCompositionPublisher(runtime, headlessHost, options.environment);
  };

  const activateFacets = async (installed: InstalledServerFacets): Promise<void> => {
    if (headlessHost === undefined) throw new Error('Direct headless host was not prepared.');
    headlessHost.setAvailableSources(installed.installedPackages);
    await headlessHost.select(initialSelection);
    headlessReady = headlessHost.status.ready;
    if (headlessReady) {
      await headlessHost.dispatchHook('session_start', {});
      await publishComposition();
    }
  };

  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      if (disposed) return;
      disposed = true;
      headlessReady = false;
      const failures: unknown[] = [];
      try {
        if (headlessHost?.status.ready) await headlessHost.dispatchHook('session_shutdown', {});
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

  return {
    runtime,
    get host() {
      return headlessHost;
    },
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
