import * as fs from 'node:fs';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import type { LaunchConfig } from '../runs/background/asyncExecution';
import { startParentWatchdog } from '../runs/background/parentWatchdog';
import { recordNonBlockingExtensionError } from '../../services/runs/extensionErrorTelemetry';
import { writeAtomicJson } from '../atomicJson';
import { createChildTranscriptWriter } from './childTranscript';
import { adoptSessionScopeFromEnv, currentRunConfigPath } from '../filesystem/paths';
import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../../types/environment';

const SDK_RUNTIME = 'sdk';
const CHILD_STARTED_EVENT = 'doom_team.child_started';
const CHILD_FINISHED_EVENT = 'doom_team.child_finished';
const CHILD_FAILED_EVENT = 'doom_team.child_failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLaunchConfig(runId: string): LaunchConfig {
  const configPath = currentRunConfigPath(runId);
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isRecord(parsed) || parsed.runId !== runId || !isRecord(parsed.sdk)) {
    throw new Error(`Launch config for run '${runId}' is invalid.`);
  }
  return parsed as unknown as LaunchConfig;
}

function createSessionManager(config: LaunchConfig): SessionManager {
  const { cwd, sdk } = config;
  if (sdk.sessionFile) return SessionManager.open(sdk.sessionFile, sdk.sessionDir, cwd);
  if (sdk.sessionEnabled) return SessionManager.create(cwd, sdk.sessionDir);
  return SessionManager.inMemory(cwd);
}

function writeStartupError(config: LaunchConfig | undefined, error: unknown): void {
  const handshakePath = config?.handshakePath;
  if (!handshakePath || fs.existsSync(handshakePath)) return;
  writeAtomicJson(handshakePath, { state: 'error', error: errorMessage(error) });
}

let stopWatchdog: (() => void) | undefined;
let childTelemetry: DoomTelemetry | undefined;

async function finishTelemetry(event: string, attributes: Record<string, unknown>, error?: unknown): Promise<void> {
  const telemetry = childTelemetry;
  childTelemetry = undefined;
  if (!telemetry) return;
  if (error === undefined) await telemetry.recordEvent(event, attributes);
  else await telemetry.recordError(event, error, attributes);
  await telemetry.flush();
  await telemetry.shutdown();
}

export async function runSdkChild(): Promise<void> {
  const startedAt = Date.now();
  childTelemetry = createDoomTelemetry({
    serviceName: 'doom-team-sdk-child',
    packageName: '@agimon-ai/doompi-team',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
  if (!runId) throw new Error(`${SUBAGENT_RUN_ID_ENV} is required.`);
  // Before the launch config is read: its own path is scoped, so a child that
  // was spawned without a scope cannot find anything and should say why.
  if (!adoptSessionScopeFromEnv()) {
    throw new Error(`${SUBAGENT_ROOT_SESSION_ENV} is required: a child cannot resolve its session scope without it.`);
  }

  let config: LaunchConfig | undefined;
  try {
    config = readLaunchConfig(runId);
    const launchConfig = config;
    await childTelemetry?.recordEvent(CHILD_STARTED_EVENT, {
      runtime: SDK_RUNTIME,
      'agent.name': launchConfig.agent,
      ...(launchConfig.sdk.model ? { 'model.id': launchConfig.sdk.model } : {}),
      outcome: 'started',
    });
    const { sdk } = launchConfig;
    const agentDir = getAgentDir();
    const services = await createAgentSessionServices({
      cwd: config.cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: sdk.extensions,
        additionalSkillPaths: sdk.skillPaths,
        noExtensions: sdk.noAmbientExtensions,
        noSkills: sdk.noSkills,
        noContextFiles: sdk.noContextFiles,
        ...(sdk.systemPromptMode === 'replace' ? { systemPrompt: sdk.systemPrompt } : {}),
        ...(sdk.systemPrompt && sdk.systemPromptMode !== 'replace' ? { appendSystemPrompt: [sdk.systemPrompt] } : {}),
      },
    });
    const serviceError = services.diagnostics.find((diagnostic) => diagnostic.type === 'error');
    if (serviceError) throw new Error(serviceError.message);

    const resolved = sdk.model
      ? resolveCliModel({ cliModel: sdk.model, modelRuntime: services.modelRuntime })
      : undefined;
    if (resolved && !resolved.model) throw new Error(resolved.error ?? `Model '${sdk.model}' was not found.`);

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: createSessionManager(config),
      ...(resolved?.model ? { model: resolved.model } : {}),
      ...(resolved?.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
      ...(sdk.tools ? { tools: sdk.tools } : {}),
      ...(sdk.noTools ? { noTools: sdk.noTools } : {}),
      ...(sdk.excludeTools ? { excludeTools: sdk.excludeTools } : {}),
    });
    // The parent cannot signal us if it was SIGKILLed, and we are in our own
    // process group so its terminal cannot either. This is the only thing that
    // ends this run in that case.
    stopWatchdog = startParentWatchdog({
      onParentLost: () => {
        session.dispose();
        void finishTelemetry(CHILD_FINISHED_EVENT, {
          runtime: SDK_RUNTIME,
          'agent.name': launchConfig.agent,
          duration_ms: Date.now() - startedAt,
          outcome: 'parent_lost',
        }).finally(() => process.exit(0));
      },
    });

    const transcript = config.transcriptPath
      ? createChildTranscriptWriter({
          transcriptPath: config.transcriptPath,
          source: 'async',
          runId: config.runId,
          agent: config.agent,
          childIndex: config.childIndex,
          cwd: config.cwd,
        })
      : undefined;
    transcript?.writeInitialUserMessage(config.task);
    const unsubscribe = session.subscribe((event) => {
      transcript?.writeChildEvent(event);
      if (event.type !== 'agent_end') return;
      // Pi emits session listeners only after awaiting every extension's
      // agent_end handler, including Doom Team's terminal persistence. Defer
      // one event-loop turn so every listener observes the event, then end
      // this dedicated one-session process unless an agent_end handler queued
      // a nudge or follow-up that Pi still needs to run.
      setImmediate(() => {
        if (session.agent.hasQueuedMessages()) return;
        session.dispose();
        void finishTelemetry(CHILD_FINISHED_EVENT, {
          runtime: SDK_RUNTIME,
          'agent.name': launchConfig.agent,
          duration_ms: Date.now() - startedAt,
          outcome: 'completed',
        }).finally(() => process.exit(0));
      });
    });

    try {
      await session.bindExtensions({
        mode: 'print',
        onError: (failure) => {
          recordNonBlockingExtensionError(childTelemetry, failure);
        },
      });
      await session.prompt(config.task);
    } finally {
      stopWatchdog?.();
      unsubscribe();
      session.dispose();
      await finishTelemetry(CHILD_FINISHED_EVENT, {
        runtime: SDK_RUNTIME,
        'agent.name': launchConfig.agent,
        duration_ms: Date.now() - startedAt,
        outcome: 'completed',
      });
    }
  } catch (error) {
    writeStartupError(config, error);
    await finishTelemetry(CHILD_FAILED_EVENT, { outcome: 'failed' }, error);
    throw error;
  }
}

void runSdkChild().then(
  () => {
    // This entry point owns a dedicated detached process for exactly one SDK
    // session. Extensions may retain polling intervals after session.dispose(),
    // so a successful run must terminate explicitly once synchronous result
    // persistence and session cleanup have completed.
    process.exit(0);
  },
  async (error: unknown) => {
    await finishTelemetry(CHILD_FAILED_EVENT, { outcome: 'failed' }, error);
    const failure = error instanceof Error ? error : new Error('Doom Team SDK child failed', { cause: error });
    setImmediate(() => {
      throw failure;
    });
  },
);
