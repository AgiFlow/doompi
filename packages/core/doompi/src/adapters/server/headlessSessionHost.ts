import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type { InstalledServerFacets } from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { createHeadlessClient } from './headlessClient.ts';
import { HeadlessHost } from './headlessHost.ts';
import { createDirectHarnessRuntime } from './directHarnessRuntime.ts';
import { createHistoryOwnership } from '../serialization/historyOwnership.ts';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../../types/server/headlessSessionHost.ts';
import type { AgentProcess, SessionFrame } from '../../types/server/session.ts';
import type { ResolvedHeadlessResource } from '../../types/server/headlessHost.ts';
import {
  getAgentDir,
  ModelRuntime,
  parseArgs,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type Args,
} from '@earendil-works/pi-coding-agent';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { AgentHarnessResources, AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { Model, Api } from '@earendil-works/pi-ai';
import path from 'node:path';

/** Explicit test-only switch for the same-process server adapter. */
export const DIRECT_HEADLESS_OPT_IN_ENV = 'DOOMPI_TEST_DIRECT_HEADLESS';

export function isDirectHeadlessOptedIn(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[DIRECT_HEADLESS_OPT_IN_ENV] === '1';
}

type AnyRecord = Record<string, unknown>;
type HeadlessTool = DoomHeadlessTool;

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
      skills.push({
        name: resource.name,
        description: `Headless skill from ${resource.source}`,
        content: resource.text,
        filePath: `doom-headless://${resource.source}/${resource.name}`,
      });
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
        (partial) =>
          onUpdate({
            content: partial.content,
            details: partial.details,
            ...(partial.isError ? { isError: true } : {}),
          }),
        executionContext(),
      );
      return {
        content: result.content,
        details: result.details,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
}

function eventHook(event: string): string | undefined {
  const hooks: Record<string, string> = {
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
    compaction_start: 'session_before_compact',
    compaction_end: 'session_compact',
    navigation_start: 'session_before_tree',
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

  let promptPreparationFailed = false;
  let headlessReady = false;
  const initialSystemPrompt = [parsed.systemPrompt, ...(parsed.appendSystemPrompt ?? [])].filter(Boolean).join('\n\n');
  const runtime = await createDirectHarnessRuntime({
    cwd: options.cwd,
    sessionId: options.sessionId,
    historyOwnership: createHistoryOwnership(),
    sessionName: parsed.name ?? options.sessionName,
    ...(parsed.session === undefined ? {} : { sessionPath: parsed.session }),
    ...(parsed.sessionDir === undefined ? {} : { sessionsRoot: parsed.sessionDir }),
    models: modelRuntime,
    model: resolved.model,
    ...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    beforeModelRequest: async ({ phase }) => {
      if (!headlessReady || !headlessHost) throw new Error('Headless capabilities are not installed.');
      if (phase === 'turn') await headlessHost.select({});
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
    guardModelRequest: () => {
      if (!headlessReady || promptPreparationFailed || !headlessHost?.status.ready)
        throw new Error('Headless capability preparation is not ready.');
    },
  });

  let currentModel = await runtime.lane.getModel(BACKGROUND_CONTEXT);
  let entries: readonly AnyRecord[] = (await runtime.lane.findEntries(
    { order: 'oldestFirst' },
    BACKGROUND_CONTEXT,
  )) as unknown as AnyRecord[];
  const listeners = new Set<(frame: SessionFrame) => void>();
  let headlessHost: HeadlessHost | undefined;
  let client: ReturnType<typeof createHeadlessClient> | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const executionContext = (selection: DoomHeadlessSelection): DoomHeadlessExecutionContext => ({
    cwd: options.cwd,
    repoRoot: options.repoRoot,
    sessionId: runtime.sessionId,
    client: client!.client,
    model: currentModel === undefined ? undefined : modelIdentity(currentModel),
    selection,
    session: {
      entries: () => entries,
      async appendCustomEntry(type, data) {
        await runtime.appendCustomEntry(type, data);
        entries = (await runtime.lane.findEntries(
          { order: 'oldestFirst' },
          BACKGROUND_CONTEXT,
        )) as unknown as AnyRecord[];
      },
      prompt: (text, delivery) =>
        delivery === 'steer'
          ? runtime.steer(text)
          : delivery === 'followUp'
            ? runtime.followUp(text)
            : runtime.prompt(text),
      abort: () => runtime.abort(),
      compact: (instructions) => runtime.compact(instructions),
    },
    shutdown: () => stop(),
  });

  client = createHeadlessClient({
    appendCustomEntry: async (type, data) => {
      await runtime.appendCustomEntry(type, data);
      entries = (await runtime.lane.findEntries(
        { order: 'oldestFirst' },
        BACKGROUND_CONTEXT,
      )) as unknown as AnyRecord[];
    },
    emitFrame: (frame) => emitTo(listeners, frame),
  });

  runtime.onFrame((frame) => emitTo(listeners, frame));
  const unsubscribeEvents = runtime.onEvent(async (event, _context) => {
    if (event.type === 'config_update' && event.property === 'model') {
      currentModel = await runtime.lane.getModel(BACKGROUND_CONTEXT);
    }
    const eventRecord = event as unknown as AnyRecord;
    if (event.type === 'entry_added' && eventRecord.entry !== undefined && typeof eventRecord.entry === 'object')
      entries = [...entries, eventRecord.entry as AnyRecord];
    const hook = eventHook(event.type);
    if (headlessHost !== undefined && hook !== undefined && headlessHost.status.ready)
      await headlessHost.dispatchHook(hook as never, event as unknown as AnyRecord);
  });

  const prepareFacets = (root: CordisContext): void => {
    if (headlessHost !== undefined) throw new Error('Direct headless facets were prepared more than once.');
    headlessHost = new HeadlessHost(root, {
      candidates: options.candidates,
      selection: options.selection,
      context: executionContext,
      applyTools: async (tools) =>
        runtime.replaceTools(tools.map((tool) => toolAdapter(tool, () => headlessHost!.context))),
      applyResources: async (next) => {
        const mapped = mapResources(next);
        await runtime.replaceResources(mapped.harness);
      },
      onError: (error) =>
        options.onNotice?.(`Headless selection failed: ${error instanceof Error ? error.message : String(error)}`),
    });
  };

  const activateFacets = async (installed: InstalledServerFacets): Promise<void> => {
    if (headlessHost === undefined) throw new Error('Direct headless host was not prepared.');
    headlessHost.setAvailableSources(installed.installedPackages);
    await headlessHost.select(options.selection);
    headlessReady = headlessHost.status.ready;
    if (headlessReady) await headlessHost.dispatchHook('session_start', {});
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
      client?.dispose();
      unsubscribeEvents();
      try {
        await headlessHost?.close();
      } catch (error) {
        failures.push(error);
      }
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

  const agent: AgentProcess = {
    send(frame) {
      if (client?.receive(frame)) return;
      runtime.send(frame);
    },
    onFrame(listener) {
      listeners.add(listener);
    },
    exited: runtime.exited,
    endInput: stop,
    stop,
  };

  return {
    agent,
    runtime,
    get host() {
      return headlessHost;
    },
    prepareFacets,
    activateFacets,
    canDispatch: () => !disposed && headlessReady && !promptPreparationFailed && headlessHost?.status.ready === true,
    dispose,
  };
}
