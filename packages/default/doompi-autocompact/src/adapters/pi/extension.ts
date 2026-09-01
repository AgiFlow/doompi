import { getHarnessState, loadDoomConfig, type PlanningAgentConfig } from '@agimon-ai/doompi-config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
  type DoomContextContributionEntry,
  type DoomContextContributionError,
  type DoomContextContributionsService,
  type DoomContextContributionsSnapshot,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import type { DoomFooterContributionHandle } from '@agimon-ai/doompi-extension-contracts/footer';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  buildSessionContext,
  DEFAULT_COMPACTION_SETTINGS,
  generateSummary,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent';
import {
  baselineUsageIsSettled,
  checkpointRequestDetails,
  checkpointSummaryFromEntry,
  createInitialState,
  createRequestId,
  fileDetailsFromUnknown,
  fileOperationsFromMessages,
  isStructuredCheckpoint,
  latestCheckpointArtifactEntry,
  mergeFileDetails,
  parseCheckpointDecision,
  parseState,
  projectContextMessages,
  retainedMessagesAfterSnapshot,
  thresholdTokens,
  withCanonicalFileSections,
} from '../../adapters/compaction/policy';
import { parseModelReference, type SummarizationModel } from '../../services/summarizationModel.ts';
import {
  CHECKPOINT_MESSAGE_TYPE,
  CONTEXT_MESSAGE_TYPE,
  MAX_INVALID_CHECKPOINT_ATTEMPTS,
  RESUME_MESSAGE_TYPE,
  RUNTIME_STATE_MESSAGE_TYPE,
  STATE_CUSTOM_TYPE,
  STATE_VERSION,
} from '../../types/constants.ts';
import type { AutocompactEventAttributes, AutocompactTelemetry } from '../telemetry/logSinkTelemetry.ts';
import { AUTOCOMPACT_EVENT, createAutocompactTelemetry } from '../telemetry/logSinkTelemetry.ts';

export type { ModelReference, SummarizationModel } from '../../services/summarizationModel.ts';
export { parseModelReference, resolveSummarizationModel } from '../../services/summarizationModel.ts';

import type {
  AutocompactContextDetails,
  AutocompactPass,
  AutocompactRatioOverrides,
  AutocompactState,
} from '../../types/index.ts';

const ROOT_WORKING_LEAF = '@root';
const PACKAGE_SOURCE = '@agimon-ai/doompi-autocompact';
const PLAN_DOCUMENT_ENTRY = 'agent-harness-plan-document';
const FOOTER_SOURCE = 'doom-autocompact';
const FOOTER_ORDER = 20;
const STATUS_KEY = 'doom-autocompact';
const STATE_PHASE = {
  waiting: 'waiting',
  checkpointPending: 'checkpoint_pending',
  checkpointReady: 'checkpoint_ready',
  compacting: 'compacting',
} as const;
type CheckpointCapture = 'none' | 'pass1' | 'committed' | 'deferred' | 'invalid';
type CheckpointMessages = ReturnType<typeof buildSessionContext>['messages'];

interface PlanSnapshot {
  content: string;
  path: string;
}

interface SteeringSnapshot {
  plan?: PlanSnapshot;
  contextContributions: DoomContextContributionsSnapshot;
  readFiles: string[];
  modifiedFiles: string[];
}

interface RuntimeStateSnapshot {
  planPath?: string;
  contributions: readonly DoomContextContributionEntry[];
  contributionErrors: readonly DoomContextContributionError[];
}

interface CheckpointGenerationInput {
  messages: CheckpointMessages;
  instructions: string;
  previousCheckpoint?: string;
  context: ExtensionContext;
  signal: AbortSignal;
}

export interface AutocompactDependencies {
  generateCheckpoint?: (input: CheckpointGenerationInput) => Promise<string>;
  resolveModel?: (context: ExtensionContext) => SummarizationModel | undefined;
  telemetry?: AutocompactTelemetry;
  doomIntegrations?: boolean;
}

function telemetryAttributes(
  context: ExtensionContext,
  attributes: AutocompactEventAttributes = {},
): AutocompactEventAttributes {
  return {
    'pi.session.id': context.sessionManager.getSessionId(),
    ...attributes,
  };
}

function latestPersistedState(branch: SessionEntry[]): AutocompactState | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== 'custom' || entry.customType !== STATE_CUSTOM_TYPE) continue;
    const parsed = parseState(entry.data);
    if (parsed) return parsed;
  }
  return undefined;
}

function workingLeafId(ctx: ExtensionContext): string {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE) continue;
    if (entry.type === 'label') continue;
    return entry.id;
  }
  return ROOT_WORKING_LEAF;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestPlanSnapshot(branch: SessionEntry[]): PlanSnapshot | undefined {
  for (const entry of branch.toReversed()) {
    if (entry.type !== 'custom' || entry.customType !== PLAN_DOCUMENT_ENTRY) continue;
    if (!entry.data || typeof entry.data !== 'object') return undefined;
    const data = entry.data as Record<string, unknown>;
    if (typeof data.content !== 'string' || typeof data.path !== 'string') return undefined;
    return { content: data.content, path: data.path };
  }
  return undefined;
}

const EMPTY_CONTEXT_CONTRIBUTIONS: DoomContextContributionsSnapshot = Object.freeze({
  entries: Object.freeze([]),
  errors: Object.freeze([]),
});

function readContextContributionsSnapshot(
  service: DoomContextContributionsService | undefined,
): DoomContextContributionsSnapshot {
  if (!service) return EMPTY_CONTEXT_CONTRIBUTIONS;
  try {
    return service.snapshot();
  } catch (error) {
    return {
      entries: [],
      errors: [
        {
          source: DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
          id: 'service-snapshot',
          label: 'Context contributions',
          order: 0,
          message: errorMessage(error),
        },
      ],
    };
  }
}

function formatContextContributions(snapshot: DoomContextContributionsSnapshot): string {
  const sections = snapshot.entries.map((entry) => `### ${entry.label}\n${entry.text}`);
  sections.push(...snapshot.errors.map((error) => `### ${error.label}\n(unavailable: ${error.message})`));
  return sections.length > 0 ? sections.join('\n\n') : '(no registered context contributions)';
}

function runtimeStateSnapshot(
  branch: SessionEntry[],
  contextContributions: DoomContextContributionsSnapshot,
): RuntimeStateSnapshot {
  const plan = latestPlanSnapshot(branch);
  return {
    ...(plan ? { planPath: plan.path } : {}),
    contributions: contextContributions.entries,
    contributionErrors: contextContributions.errors,
  };
}

function formatRuntimeState(snapshot: RuntimeStateSnapshot): string {
  const plan = snapshot.planPath
    ? `Source: ${snapshot.planPath}\nExact plan content is restored separately by Doom Plan.`
    : '(no active plan document)';
  return `<compaction-runtime-state>
Authoritative runtime state captured when compaction committed. Use it to resume coordination without reconstructing state from the summary.
<active-plan>
${plan}
</active-plan>
<context-contributions>
${formatContextContributions({ entries: snapshot.contributions, errors: snapshot.contributionErrors })}
</context-contributions>
</compaction-runtime-state>`;
}

function runtimeTelemetryAttributes(snapshot: RuntimeStateSnapshot): AutocompactEventAttributes {
  return {
    'autocompact.runtime.plan_present': Boolean(snapshot.planPath),
    'autocompact.runtime.contribution_count': snapshot.contributions.length,
    'autocompact.runtime.contribution_error_count': snapshot.contributionErrors.length,
  };
}

function steeringEnvelope(snapshot: SteeringSnapshot): string {
  const plan = snapshot.plan
    ? `Source: ${snapshot.plan.path}\n\n${snapshot.plan.content}`
    : '(no active plan document)';
  const importantContext = [
    snapshot.readFiles.length > 0 ? `Read files: ${snapshot.readFiles.join(', ')}` : undefined,
    snapshot.modifiedFiles.length > 0 ? `Modified files: ${snapshot.modifiedFiles.join(', ')}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return `<compaction-steering priority="user,plan,context-contributions,important-context,recent-messages">
<user-prompt source="conversation">
Treat the user's explicit goals, constraints, corrections, and preferences in the conversation as authoritative. Newer user instructions override older ones.
</user-prompt>
<active-plan>
${plan}
</active-plan>
<context-contributions>
${formatContextContributions(snapshot.contextContributions)}
</context-contributions>
<important-context>
${importantContext.length > 0 ? importantContext.join('\n') : '(none recorded outside the conversation)'}
</important-context>
</compaction-steering>`;
}

function checkpointInstructions(pass: AutocompactPass, steering: SteeringSnapshot): string {
  const decision =
    pass === 2
      ? 'Start with exactly <shouldCompact>true</shouldCompact> or <shouldCompact>false</shouldCompact>. Use true when the staged summary safely retains the important parent context. Use false only when it is not yet sufficient for safe compaction.\n\n'
      : '';

  // Summarization is a tool-less single LLM call, so instructions describe only what to
  // produce. Directives aimed at an implementing agent leak into the checkpoint body.
  return `Create Doom autocompact checkpoint pass ${pass}.

${steeringEnvelope(steering)}

Apply the steering evidence in priority order. Do not invent plan or contributed runtime state. Preserve verified facts and mark unresolved inference explicitly. Newer evidence replaces superseded information.

${decision}Return only the decision tag when required, followed by a concise structured checkpoint using every heading below. Keep exact goals, constraints, decisions, blockers, commands, errors, file paths, validation evidence, and the immediate next action. Separate verified facts from unresolved inference.

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context`;
}

function messagesForCheckpoint(
  pass: AutocompactPass,
  branch: SessionEntry[],
  previousSnapshotLeafId: string | undefined,
): CheckpointMessages {
  const projected = projectContextMessages(buildSessionContext(branch).messages, branch).messages;
  if (pass === 1 || !previousSnapshotLeafId) return projected;
  const snapshotIndex = branch.findIndex((entry) => entry.id === previousSnapshotLeafId);
  if (snapshotIndex === -1) return projected;
  return branch
    .slice(snapshotIndex + 1)
    .filter((entry) => entry.type !== 'custom_message' || entry.customType !== CHECKPOINT_MESSAGE_TYPE)
    .flatMap((entry) => sessionEntryToContextMessages(entry));
}

interface AutocompactRuntimeConfig {
  /** Off leaves compaction to Pi; unset is on. */
  enabled: boolean;
  /** The agent that writes the summaries, from autocompact's own keys or planning's. */
  agent?: PlanningAgentConfig;
  ratios: AutocompactRatioOverrides;
}

const DEFAULT_RUNTIME_CONFIG: AutocompactRuntimeConfig = { enabled: true, ratios: {} };

/**
 * What the Doom config says about this package.
 *
 * `modes.autocompact` is read first and `modes.planning.subagents` is the
 * fallback, because summarization borrowed the planning subagent model before
 * it had keys of its own and existing files still spell it that way.
 */
export function autocompactRuntimeConfig(
  cwd: string,
  onLoadFailure?: (error: unknown) => void,
): AutocompactRuntimeConfig {
  let modes: ReturnType<typeof loadDoomConfig>['modes'];
  try {
    modes = loadDoomConfig(getHarnessState().root ?? cwd).modes;
  } catch (error) {
    process.emitWarning('Doom autocompact configuration could not be loaded; using the active session model instead.');
    onLoadFailure?.(error);
    return DEFAULT_RUNTIME_CONFIG;
  }
  const configured = modes?.autocompact;
  const ownAgent: PlanningAgentConfig | undefined =
    configured && (configured.model !== undefined || configured.thinking !== undefined)
      ? {
          ...(configured.model ? { model: configured.model } : {}),
          ...(configured.thinking ? { thinking: configured.thinking } : {}),
        }
      : undefined;
  const agent = ownAgent ?? modes?.planning?.subagents;
  const thresholds = configured?.thresholds;
  return {
    enabled: configured?.enabled ?? true,
    ...(agent ? { agent } : {}),
    ratios: {
      ...(thresholds?.pass1 === undefined ? {} : { 1: thresholds.pass1 }),
      ...(thresholds?.pass2 === undefined ? {} : { 2: thresholds.pass2 }),
      ...(thresholds?.pass3 === undefined ? {} : { 3: thresholds.pass3 }),
    },
  };
}

/** Explicit Doom model selection honors the configured summarization model. */
export function resolveDoomSummarizationModel(ctx: ExtensionContext): SummarizationModel | undefined {
  const configured = autocompactRuntimeConfig(ctx.cwd).agent;
  const reference = configured?.model ? parseModelReference(configured.model) : undefined;
  const configuredModel = reference ? ctx.modelRegistry.find(reference.provider, reference.modelId) : undefined;
  const model = configuredModel ?? ctx.model;
  if (!model) return undefined;
  const thinkingLevel =
    configured?.thinking ?? (configuredModel ? reference?.thinking : undefined) ?? ctx.thinkingLevel;
  return { model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/**
 * Summarization borrows the session's own provider instead of re-resolving one.
 *
 * The selected model can come from a Pi provider extension, and that extension's
 * `streamSimple` closure lives only in this process: it is never in Pi's global api
 * registry, so any other thread or process sees `No API provider registered for api`.
 * Passing the composed provider in as `generateSummary`'s stream function keeps
 * summarization on exactly the path the agent's own requests take.
 */
export async function generateCheckpointWithPi(
  input: CheckpointGenerationInput,
  resolveModel: (context: ExtensionContext) => SummarizationModel | undefined,
): Promise<string> {
  const selection = resolveModel(input.context);
  if (!selection) throw new Error('No active model is available for autocompact summarization.');
  const auth = await input.context.modelRegistry.getApiKeyAndHeaders(selection.model);
  if (!auth.ok) throw new Error(auth.error);
  const provider = input.context.modelRegistry.getProvider(selection.model.provider);
  if (!provider) {
    throw new Error(`No provider is registered for "${selection.model.provider}" in this session.`);
  }
  return generateSummary(
    input.messages,
    selection.model,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    auth.apiKey,
    // A null header value suppresses a provider default, which the narrower
    // `generateSummary` signature does not model but every provider honors.
    auth.headers as Record<string, string> | undefined,
    input.signal,
    input.instructions,
    input.previousCheckpoint,
    selection.thinkingLevel,
    (model, context, options) => provider.streamSimple(model, context, options),
    auth.env,
  );
}

function notify(ctx: ExtensionContext | undefined, message: string, level: 'info' | 'warning' | 'error' = 'info') {
  if (ctx?.hasUI) ctx.ui.notify(message, level);
}

export function installAutocompactRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: AutocompactDependencies = {},
): void {
  const resolveModel = dependencies.resolveModel ?? resolveDoomSummarizationModel;
  const generateCheckpoint =
    dependencies.generateCheckpoint ??
    ((input: CheckpointGenerationInput) => generateCheckpointWithPi(input, resolveModel));
  const telemetry = dependencies.telemetry ?? createAutocompactTelemetry();
  const doomIntegrations = dependencies.doomIntegrations ?? true;
  const appliedContextRequests = new Set<string>();
  const invalidContextLeaves = new Set<string>();
  const checkpointWork = new Set<Promise<void>>();
  let active = true;
  let sessionGeneration = 0;
  let state = createInitialState();
  let currentContext: ExtensionContext | undefined;
  let checkpointController: AbortController | undefined;
  let footerContribution: DoomFooterContributionHandle | undefined;
  let contextContributionsService: DoomContextContributionsService | undefined;
  let configLoadFailureReported = false;

  cordis.effect(
    () => async () => {
      active = false;
      sessionGeneration += 1;
      checkpointController?.abort(new Error('Autocompact runtime is shutting down.'));
      checkpointController = undefined;
      await Promise.allSettled(checkpointWork);
      footerContribution = undefined;
      contextContributionsService = undefined;
      currentContext = undefined;
      appliedContextRequests.clear();
      invalidContextLeaves.clear();
      state = createInitialState();
      configLoadFailureReported = false;
      await telemetry.shutdown();
    },
    `${FOOTER_SOURCE}/runtime`,
  );

  cordis.inject([DOOM_CONTEXT_CONTRIBUTIONS_SERVICE], (contextContributionsContext) => {
    const service = requireDoomContextContributions(contextContributionsContext);
    contextContributionsService = service;
    return () => {
      if (contextContributionsService === service) contextContributionsService = undefined;
    };
  });

  if (doomIntegrations) {
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const contribution = requireDoomUiHub(uiContext).registerFooter({
        source: FOOTER_SOURCE,
        id: 'autocompact',
        order: FOOTER_ORDER,
      });
      footerContribution = contribution;
      return () => {
        contribution.dispose();
        if (footerContribution === contribution) footerContribution = undefined;
      };
    });
  }

  /** Compaction runs off the main thread, so the phase is the only signal the user gets. */
  const refreshStatus = (ctx?: ExtensionContext): void => {
    if (!active) return;
    const phase =
      state.phase === STATE_PHASE.checkpointPending
        ? 'summarizing'
        : state.phase === STATE_PHASE.checkpointReady
          ? 'applying'
          : undefined;
    footerContribution?.update(
      phase ? { fullText: `Compacting p${state.pass}`, compactText: `C${state.pass}` } : undefined,
    );
    const target = ctx ?? currentContext;
    if (target?.hasUI) target.ui.setStatus(STATUS_KEY, phase ? `Compacting pass ${state.pass} (${phase})…` : undefined);
  };

  // Every phase transition persists, so this is the one place that keeps the status honest.
  const persist = (): void => {
    if (!active) return;
    pi.appendEntry(STATE_CUSTOM_TYPE, { ...state });
    refreshStatus();
  };

  const clearPendingCheckpoint = (): void => {
    delete state.requestId;
    delete state.snapshotLeafId;
    delete state.snapshotTokens;
    delete state.pendingCheckpoint;
    delete state.compactionPass;
  };

  const completeQueuedPass = (pass: AutocompactPass): void => {
    state.checkpointQueue = state.checkpointQueue.filter((queuedPass) => queuedPass !== pass);
  };

  const restore = (ctx: ExtensionContext): void => {
    if (!active) return;
    state = latestPersistedState(ctx.sessionManager.getBranch()) ?? createInitialState();
    const resumablePending =
      state.phase === STATE_PHASE.checkpointReady && state.requestId && state.snapshotLeafId && state.pendingCheckpoint;
    if (resumablePending || state.phase === STATE_PHASE.waiting) return;

    checkpointController?.abort();
    checkpointController = undefined;
    state.phase = STATE_PHASE.waiting;
    clearPendingCheckpoint();
    persist();
  };

  const resumeAgent = (message: string): void => {
    if (!active) return;
    pi.sendMessage(
      {
        customType: RESUME_MESSAGE_TYPE,
        content: `${message} Continue from the compacted checkpoint's immediate next action without repeating completed work.`,
        display: false,
        details: { version: STATE_VERSION, cycle: state.cycle, pass: state.pass },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    );
  };

  /**
   * Both failure paths share one attempt budget: a summarizer that keeps failing would
   * otherwise cost a full summarization call every turn for the rest of the session, so the
   * pass is abandoned once the budget is spent and becomes eligible again on the next cycle.
   */
  const registerFailedAttempt = (
    pass: AutocompactPass,
    failedLeafId: string | undefined,
  ): { attempts: number; exhausted: boolean } => {
    const attempts = state.invalidAttempts + 1;
    const exhausted = attempts >= MAX_INVALID_CHECKPOINT_ATTEMPTS;
    state.phase = STATE_PHASE.waiting;
    if (failedLeafId) state.lastAttemptLeafId = failedLeafId;
    if (exhausted) {
      completeQueuedPass(pass);
      state.exhaustedPasses = [...state.exhaustedPasses, pass];
      state.invalidAttempts = 0;
    } else {
      state.invalidAttempts = attempts;
    }
    clearPendingCheckpoint();
    persist();
    return { attempts, exhausted };
  };

  const failCheckpoint = (requestId: string, error: unknown): void => {
    if (!active || requestId !== state.requestId || state.phase !== STATE_PHASE.checkpointPending) return;
    const pass = state.pass;
    const { attempts, exhausted } = registerFailedAttempt(pass, state.snapshotLeafId);
    const reason = error instanceof Error ? error.message : String(error);
    notify(
      currentContext,
      exhausted
        ? `Doom autocompact summarization pass ${pass} failed ${attempts} times and was abandoned: ${reason}`
        : `Doom autocompact summarization pass ${pass} failed: ${reason}`,
      'error',
    );
  };

  // A configuration that cannot be read degrades every later pass silently, and the process
  // warning never reaches the log sink. Report it once per session instead of once per turn.
  const reportConfigLoadFailure = (ctx: ExtensionContext, error: unknown): void => {
    if (!active || configLoadFailureReported) return;
    configLoadFailureReported = true;
    void telemetry.recordWarning(
      AUTOCOMPACT_EVENT.configurationLoadFailed,
      error,
      telemetryAttributes(ctx, { 'autocompact.cycle': state.cycle, 'autocompact.pass': state.pass }),
    );
  };

  const reportContributionFailures = (
    ctx: ExtensionContext,
    snapshot: DoomContextContributionsSnapshot,
    attributes: AutocompactEventAttributes,
  ): void => {
    if (!active) return;
    for (const error of snapshot.errors) {
      notify(
        ctx,
        `Doom autocompact context contribution degraded (${error.source}/${error.id}): ${error.message}`,
        'warning',
      );
      void telemetry.recordWarning(AUTOCOMPACT_EVENT.contextContributionDegraded, new Error(error.message), {
        ...attributes,
        'autocompact.context_contribution.source': error.source,
        'autocompact.context_contribution.id': error.id,
        'autocompact.context_contribution.order': error.order,
      });
    }
  };

  const preserveRuntimeState = (
    ctx: ExtensionContext,
    branch: SessionEntry[],
    attributes: AutocompactEventAttributes,
  ): RuntimeStateSnapshot => {
    if (!active) {
      return { contributions: [], contributionErrors: [] };
    }
    const contextContributions = readContextContributionsSnapshot(contextContributionsService);
    reportContributionFailures(ctx, contextContributions, attributes);
    const snapshot = runtimeStateSnapshot(branch, contextContributions);
    pi.sendMessage({
      customType: RUNTIME_STATE_MESSAGE_TYPE,
      content: formatRuntimeState(snapshot),
      display: false,
      details: { version: 2, ...snapshot },
    });
    return snapshot;
  };

  const commitCheckpoint = (pass: 2 | 3, ctx: ExtensionContext): boolean => {
    if (!active || !state.requestId || !state.snapshotLeafId || !state.pendingCheckpoint) return false;
    const branch = ctx.sessionManager.getBranch();
    const projected = projectContextMessages(buildSessionContext(branch).messages, branch).messages;
    const fileDetails = mergeFileDetails(state, fileOperationsFromMessages(projected));
    const requestId = state.requestId;
    const cycle = state.cycle;
    const summary = withCanonicalFileSections(state.pendingCheckpoint, fileDetails);
    const details: AutocompactContextDetails = {
      ...fileDetails,
      doomAutocompact: {
        version: STATE_VERSION,
        cycle,
        pass,
        requestId,
        snapshotLeafId: state.snapshotLeafId,
        tokensBefore: state.snapshotTokens ?? ctx.getContextUsage()?.tokens ?? 0,
      },
      retainedMessages: retainedMessagesAfterSnapshot(branch, state.snapshotLeafId),
    };

    notify(ctx, `Doom autocompact pass ${pass} context commit started.`);
    const committedWhileIdle = ctx.isIdle();
    pi.sendMessage({ customType: CONTEXT_MESSAGE_TYPE, content: summary, display: false, details });
    const contextMessageLeafId = workingLeafId(ctx);
    const runtimeAttributes = telemetryAttributes(ctx, {
      'autocompact.request.id': requestId,
      'autocompact.cycle': cycle,
      'autocompact.pass': pass,
    });
    const runtimeSnapshot = preserveRuntimeState(ctx, branch, runtimeAttributes);
    // Mid-run the marker is queued as a steering message, so its entry id is not resolvable yet.
    if (committedWhileIdle) pi.setLabel(contextMessageLeafId, `autocompact:c${cycle}:p${pass}`);

    state.readFiles = fileDetails.readFiles;
    state.modifiedFiles = fileDetails.modifiedFiles;
    delete state.latestCheckpointSnapshotLeafId;
    state.phase = STATE_PHASE.waiting;
    state.checkpointQueue = [];
    // A compacted context is a fresh ladder: passes abandoned in the previous cycle are eligible again.
    state.exhaustedPasses = [];
    state.invalidAttempts = 0;
    state.baselinePending = true;
    delete state.lastAttemptLeafId;
    clearPendingCheckpoint();
    state.cycle += 1;
    state.pass = 1;
    persist();
    void telemetry.recordEvent(
      AUTOCOMPACT_EVENT.contextCommitted,
      telemetryAttributes(ctx, {
        'autocompact.request.id': requestId,
        'autocompact.cycle': cycle,
        'autocompact.pass': pass,
        'autocompact.snapshot_leaf_id': details.doomAutocompact.snapshotLeafId,
        'autocompact.tokens_before': details.doomAutocompact.tokensBefore,
        'autocompact.message_count.before': projected.length,
        'autocompact.message_count.retained': details.retainedMessages.length,
        'autocompact.apply_mode': committedWhileIdle ? 'idle' : 'turn_end',
        ...runtimeTelemetryAttributes(runtimeSnapshot),
      }),
    );
    notify(ctx, `Doom autocompact context committed. Baseline will be captured from the next settled context.`);
    // A mid-run commit needs no resume steer: the agent is already continuing.
    if (committedWhileIdle) resumeAgent('Asynchronous compaction completed.');
    return true;
  };

  const requestCheckpoint = (pass: AutocompactPass, ctx: ExtensionContext, tokensBefore: number): void => {
    if (!active) return;
    const generation = sessionGeneration;
    const branch = ctx.sessionManager.getBranch();
    const snapshotLeafId = workingLeafId(ctx);
    const requestId = createRequestId(ctx.sessionManager.getSessionId(), state.cycle, pass, snapshotLeafId);
    const previousCheckpoint = pass > 1 ? checkpointSummaryFromEntry(latestCheckpointArtifactEntry(branch)) : undefined;
    const messages = messagesForCheckpoint(pass, branch, state.latestCheckpointSnapshotLeafId);
    const contextContributions = readContextContributionsSnapshot(contextContributionsService);
    const attributes = telemetryAttributes(ctx, {
      'autocompact.request.id': requestId,
      'autocompact.cycle': state.cycle,
      'autocompact.pass': pass,
      'autocompact.snapshot_leaf_id': snapshotLeafId,
      'autocompact.tokens_before': tokensBefore,
      'autocompact.message_count.before': messages.length,
    });
    reportContributionFailures(ctx, contextContributions, attributes);

    state.phase = STATE_PHASE.checkpointPending;
    state.pass = pass;
    state.requestId = requestId;
    state.snapshotLeafId = snapshotLeafId;
    state.snapshotTokens = tokensBefore;
    delete state.pendingCheckpoint;
    delete state.compactionPass;
    delete state.lastAttemptLeafId;
    persist();

    checkpointController?.abort();
    checkpointController = new AbortController();
    const checkpointSignal = checkpointController.signal;
    notify(ctx, `Doom autocompact summarization pass ${pass} started.`);
    const operation = telemetry
      .runInSpan('doom_autocompact.checkpoint', attributes, async () => {
        await telemetry.recordEvent(AUTOCOMPACT_EVENT.checkpointStarted, attributes);
        try {
          const checkpoint = await generateCheckpoint({
            messages,
            instructions: checkpointInstructions(pass, {
              plan: latestPlanSnapshot(branch),
              contextContributions,
              readFiles: state.readFiles,
              modifiedFiles: state.modifiedFiles,
            }),
            ...(previousCheckpoint ? { previousCheckpoint } : {}),
            context: ctx,
            signal: checkpointSignal,
          });
          if (!active || generation !== sessionGeneration) {
            throw checkpointSignal.reason ?? new Error('Autocompact checkpoint became stale.');
          }
          if (!checkpoint.trim()) throw new Error('Summarization returned an empty checkpoint.');
          await telemetry.recordEvent(AUTOCOMPACT_EVENT.checkpointCompleted, {
            ...attributes,
            'autocompact.checkpoint.characters': checkpoint.length,
          });
          return checkpoint;
        } catch (error) {
          if (active && generation === sessionGeneration) {
            await telemetry.recordError(AUTOCOMPACT_EVENT.checkpointFailed, error, attributes);
          }
          throw error;
        }
      })
      .then((checkpoint) => {
        if (
          !active ||
          generation !== sessionGeneration ||
          requestId !== state.requestId ||
          state.phase !== STATE_PHASE.checkpointPending
        ) {
          return;
        }
        state.phase = STATE_PHASE.checkpointReady;
        state.pendingCheckpoint = checkpoint.trim();
        persist();
        notify(currentContext, `Doom autocompact summarization pass ${pass} completed.`);
        if (currentContext) processProgress(currentContext);
      })
      .catch((error: unknown) => {
        if (active && generation === sessionGeneration) failCheckpoint(requestId, error);
      });
    checkpointWork.add(operation);
    void operation.finally(() => checkpointWork.delete(operation));
  };

  const evaluateUsage = (ctx: ExtensionContext): boolean => {
    if (!active || state.phase !== STATE_PHASE.waiting || ctx.hasPendingMessages()) return false;
    // Read per evaluation rather than once at install, so turning the ladder off
    // or moving a threshold in settings takes effect on the next turn instead of
    // the next session.
    const configured = autocompactRuntimeConfig(ctx.cwd, (error) => reportConfigLoadFailure(ctx, error));
    if (!configured.enabled) return false;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return false;
    if (state.baselinePending) {
      // Reported usage still describes the pre-compaction context until an assistant
      // responds against the projected one, and capturing it early poisons every threshold.
      if (!baselineUsageIsSettled(ctx.sessionManager.getBranch())) return false;
      state.baselineTokens = usage.tokens;
      state.baselinePending = false;
      persist();
      notify(ctx, `Doom autocompact baseline captured at ${state.baselineTokens} tokens.`);
      return false;
    }
    const leafId = workingLeafId(ctx);
    if (state.lastAttemptLeafId === leafId) return false;

    for (const pass of [1, 2, 3] as const) {
      if (pass < state.pass || state.checkpointQueue.includes(pass) || state.exhaustedPasses.includes(pass)) continue;
      if (usage.tokens >= thresholdTokens(pass, usage.contextWindow, state.baselineTokens, configured.ratios)) {
        state.checkpointQueue.push(pass);
      }
    }
    const nextPass = state.checkpointQueue[0];
    if (!nextPass) return false;
    requestCheckpoint(nextPass, ctx, usage.tokens);
    return true;
  };

  // Staged checkpoints seed the next summarization pass only. They are appended as plain
  // session entries so they never enter the agent's LLM context: delivering them as messages
  // reads like a user instruction and derails the run ("Checkpoint acknowledged...").
  const stageCheckpoint = (pass: 1 | 2, summary: string): void => {
    if (!active) return;
    const checkpointSnapshotLeafId = state.snapshotLeafId;
    pi.appendEntry(CHECKPOINT_MESSAGE_TYPE, {
      ...checkpointRequestDetails(state.cycle, pass, state.requestId ?? 'completed'),
      summary,
    });
    if (checkpointSnapshotLeafId) state.latestCheckpointSnapshotLeafId = checkpointSnapshotLeafId;
  };

  const captureReadyCheckpoint = (ctx: ExtensionContext): CheckpointCapture => {
    if (!active || state.phase !== STATE_PHASE.checkpointReady || !state.requestId || !state.pendingCheckpoint) {
      return 'none';
    }
    const pass = state.pass;
    const decision = parseCheckpointDecision(state.pendingCheckpoint);
    if (!isStructuredCheckpoint(decision.summary)) {
      const failedLeafId = state.snapshotLeafId;
      const invalidRequestId = state.requestId;
      // A queued pass is retried once per new leaf, so an output the summarizer never formats
      // correctly would otherwise burn a full summarization call every turn for the session.
      const { attempts, exhausted } = registerFailedAttempt(pass, failedLeafId);
      const error = new Error(`Summarization pass ${pass} returned an incomplete checkpoint.`);
      notify(
        ctx,
        exhausted
          ? `Doom autocompact summarization pass ${pass} returned an incomplete checkpoint ${attempts} times and was abandoned.`
          : `Doom autocompact summarization pass ${pass} returned an incomplete checkpoint.`,
        'error',
      );
      void telemetry.recordError(
        AUTOCOMPACT_EVENT.checkpointInvalid,
        error,
        telemetryAttributes(ctx, {
          'autocompact.cycle': state.cycle,
          'autocompact.pass': pass,
          'autocompact.checkpoint.attempts': attempts,
          'autocompact.checkpoint.exhausted': exhausted,
          ...(invalidRequestId ? { 'autocompact.request.id': invalidRequestId } : {}),
        }),
      );
      return 'invalid';
    }

    state.invalidAttempts = 0;

    if (pass === 1) {
      stageCheckpoint(1, decision.summary);
      completeQueuedPass(1);
      state.phase = STATE_PHASE.waiting;
      state.pass = 2;
      clearPendingCheckpoint();
      persist();
      return 'pass1';
    }

    if (pass === 2 && decision.shouldCompact !== true) {
      stageCheckpoint(2, decision.summary);
      completeQueuedPass(2);
      state.phase = STATE_PHASE.waiting;
      state.pass = 3;
      clearPendingCheckpoint();
      persist();
      return 'deferred';
    }

    state.pendingCheckpoint = decision.summary;
    return commitCheckpoint(pass, ctx) ? 'committed' : 'invalid';
  };

  function processProgress(ctx: ExtensionContext): void {
    if (!active) return;
    currentContext = ctx;
    if (!ctx.isIdle()) return;
    if (captureReadyCheckpoint(ctx) !== 'committed') evaluateUsage(ctx);
  }

  pi.on('context', (event, ctx) => {
    if (!active) return undefined;
    const projection = projectContextMessages(event.messages, ctx.sessionManager.getBranch());
    if (projection.invalidMarker) {
      const leafId = ctx.sessionManager.getLeafId() ?? ROOT_WORKING_LEAF;
      if (!invalidContextLeaves.has(leafId)) {
        invalidContextLeaves.add(leafId);
        void telemetry.recordError(
          AUTOCOMPACT_EVENT.contextMarkerInvalid,
          new Error('Doom autocompact context marker is malformed.'),
          telemetryAttributes(ctx, { 'autocompact.leaf_id': leafId }),
        );
      }
      return undefined;
    }
    if (!projection.marker) return undefined;
    if (!appliedContextRequests.has(projection.marker.requestId)) {
      appliedContextRequests.add(projection.marker.requestId);
      void telemetry.recordEvent(
        AUTOCOMPACT_EVENT.contextApplied,
        telemetryAttributes(ctx, {
          'autocompact.request.id': projection.marker.requestId,
          'autocompact.cycle': projection.marker.cycle,
          'autocompact.pass': projection.marker.pass,
          'autocompact.snapshot_leaf_id': projection.marker.snapshotLeafId,
          'autocompact.tokens_before': projection.marker.tokensBefore,
          'autocompact.message_count.before': event.messages.length,
          'autocompact.message_count.after': projection.messages.length,
          'autocompact.message_count.retained': projection.retainedMessageCount,
        }),
      );
    }
    return { messages: projection.messages };
  });

  const beginSessionGeneration = (ctx: ExtensionContext): void => {
    if (!active) return;
    sessionGeneration += 1;
    checkpointController?.abort(new Error('Autocompact session generation was replaced.'));
    checkpointController = undefined;
    appliedContextRequests.clear();
    invalidContextLeaves.clear();
    currentContext = ctx;
    restore(ctx);
    processProgress(ctx);
  };

  pi.on('session_start', (_event, ctx) => beginSessionGeneration(ctx));

  pi.on('session_tree', (_event, ctx) => beginSessionGeneration(ctx));

  pi.on('turn_end', (event, ctx) => {
    if (!active) return;
    currentContext = ctx;
    if (ctx.isIdle()) {
      processProgress(ctx);
      return;
    }
    // A ready checkpoint must be applied without waiting for the run to finish, otherwise
    // context keeps growing past the window for the rest of a long autonomous run. Tool
    // results confirm the run continues, so the queued marker lands before the next request.
    const canApplyDuringRun =
      state.phase === STATE_PHASE.checkpointReady && (event.toolResults?.length ?? 0) > 0 && !ctx.hasPendingMessages();
    if (canApplyDuringRun && captureReadyCheckpoint(ctx) !== 'none') return;
    evaluateUsage(ctx);
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!active) return;
    processProgress(ctx);
  });

  pi.on('session_before_compact', (event) => {
    if (!active || event.reason !== 'threshold') return undefined;
    // Native compaction stays cancelled while our own machinery is working, and stays
    // available as the emergency backstop once that machinery has stalled or declined.
    const machineryActive =
      state.phase === STATE_PHASE.checkpointPending ||
      state.phase === STATE_PHASE.checkpointReady ||
      state.baselinePending;
    return machineryActive ? { cancel: true } : undefined;
  });

  pi.on('session_compact', (event, ctx) => {
    if (!active) return;
    sessionGeneration += 1;
    // Native compaction supersedes any summarization still in flight.
    checkpointController?.abort();
    checkpointController = undefined;
    const eventDetails = fileDetailsFromUnknown(event.compactionEntry.details);
    const cumulative = mergeFileDetails(state, undefined, eventDetails);
    state.readFiles = cumulative.readFiles;
    state.modifiedFiles = cumulative.modifiedFiles;
    delete state.latestCheckpointSnapshotLeafId;
    // Reported usage still describes the pre-compaction context here too, so the baseline
    // waits for the first assistant response measured against the compacted one.
    state.baselinePending = true;
    state.phase = STATE_PHASE.waiting;
    clearPendingCheckpoint();
    state.checkpointQueue = [];
    state.exhaustedPasses = [];
    state.invalidAttempts = 0;
    delete state.lastAttemptLeafId;

    pi.setLabel(event.compactionEntry.id, `autocompact:c${state.cycle}:external`);
    const completedCycle = state.cycle;
    const runtimeAttributes = telemetryAttributes(ctx, {
      'autocompact.cycle': completedCycle,
      'autocompact.native.reason': event.reason,
    });
    const runtimeSnapshot = preserveRuntimeState(ctx, ctx.sessionManager.getBranch(), runtimeAttributes);
    state.cycle += 1;
    state.pass = 1;
    persist();
    void telemetry.recordEvent(
      AUTOCOMPACT_EVENT.nativeCompactionCompleted,
      telemetryAttributes(ctx, {
        'autocompact.cycle': completedCycle,
        'autocompact.native.reason': event.reason,
        'autocompact.native.from_extension': event.fromExtension,
        'autocompact.tokens_before': event.compactionEntry.tokensBefore,
        ...runtimeTelemetryAttributes(runtimeSnapshot),
      }),
    );
    notify(
      ctx,
      `Doom autocompact completed. Baseline will be captured from the next settled context. Next pass: ${state.pass}.`,
    );
  });
}

/** The package's single standard Pi factory. */
export async function autocompactExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(autocompactPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

interface AutocompactPluginConfig {
  readonly pi: ExtensionAPI;
}

function autocompactPlugin(cordis: Context, config: AutocompactPluginConfig): void {
  installAutocompactRuntime(cordis, config.pi);
}

export default autocompactExtension;
