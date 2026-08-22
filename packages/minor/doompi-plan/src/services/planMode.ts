import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigPath } from '@agimon-ai/doompi-config';
import { setDoomConfigValue, unsetDoomConfigValue } from '@agimon-ai/doompi-config/configWriter';
import { CONFIG_ACTION, type DoomConfigContributionHandle } from '@agimon-ai/doompi-extension-contracts/config';
import {
  DOOM_FABLE_PLAN_SERVICE,
  FABLE_PLAN_REQUESTER as CONTRACT_FABLE_PLAN_REQUESTER,
  type DoomFablePlanService,
  readDoomFablePlanService,
} from '@agimon-ai/doompi-extension-contracts/fable-plan';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  MINOR_MODE_TOOL_NAME,
  type MinorModeCatalogService,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_SOURCE,
  type DoomNarrationService,
  requireDoomNarrationService,
} from '@agimon-ai/doompi-extension-contracts/narration';
import type { LeaderBinding, DoomLeaderContributionHandle } from '@agimon-ai/doompi-extension-contracts/leader';
import {
  DOOM_SUBAGENT_POLICY_SERVICE,
  type DoomSubagentPolicyService,
  readDoomSubagentPolicyService,
  type SubagentPolicyHandle,
} from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import { isSubagentAction, subagentActionAcceptsField } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import {
  DOOM_VOICE_TOOLS_SERVICE,
  requireDoomVoiceToolsService,
  VOICE_MODE_TOOL_NAMES,
  type VoiceToolDefinition,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { createPlanTelemetry, PLAN_EVENT, type PlanTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import {
  getHarnessState,
  loadDoomConfig,
  loadHarnessState,
  type PlanningAgentConfig,
  type PlanningModeConfig,
  type PlanningThinkingLevel,
  resolvePlanningPlansDirectory,
} from '../schemas/plan/config.ts';
import { type PlanModelChoice, planConfigSections, planSettingByFieldId } from '../schemas/plan/planConfig.ts';
import {
  createFablePlanFlow,
  FABLE_PLAN_PROFILE,
  type FablePlanBroker,
  type FablePlanResult,
  type FableStage,
} from './fableFlow.ts';
import { buildFlavorPlanningPrompt, type DebugEvidencePacket, type PlanningFlavor } from './prompts.ts';

const PLAN_MODE_ENTRY = 'agent-harness-plan-mode';
const PLAN_MODE_CONTEXT = 'agent-harness-plan-mode-context';
const PLAN_DOCUMENT_ENTRY = 'agent-harness-plan-document';
const COMPLETE_PLAN_TOOL = 'complete_plan';
const WRITE_PLAN_TOOL = 'write_plan';
const ASK_USER_TOOL = 'ask_user_question';
const BASH_TOOL = 'bash';
const FIND_TOOL = 'find';
const GREP_TOOL = 'grep';
const LIST_TOOL = 'ls';
const MCP_TOOL = 'mcp';
const READ_TOOL = 'read';
const SUBAGENT_TOOL = 'subagent';
const TASK_TOOL = 'task';
const RECORD_DEBUG_EVIDENCE_TOOL = 'record_debug_evidence';
const RUN_FABLE_PLAN_TOOL = 'run_fable_plan';
const DEFAULT_PLAN_TITLE = 'implementation-plan';
const PLAN_TITLE_MAX_LENGTH = 64;
const SESSION_ID_MAX_LENGTH = 48;
const PLAN_MODE_STATUS_KEY = 'plan-mode';
const PLAN_LEADER_SOURCE = '@agimon-ai/doompi-plan';
const PLAN_LEADER_GROUP_ORDER = 60;
const MODE_ID = 'plan';
const MODE_LABEL = 'Plan';
const READ_ONLY_DETAIL = 'read only';
const MODE_ORDER = 40;
const MODE_ACTIVATE_ACTION = 'activate';
const MODE_DEACTIVATE_ACTION = 'deactivate';
const WARNING_STYLE = 'warning';
const INFO_STYLE = 'info';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PLAN_ALLOCATION_ATTEMPTS = 3;
const INVALID_PLAN_DESTINATION = 'Refused to write the plan because its destination is not a regular file.';
const PLAN_TRIGGER_ATTRIBUTE = 'plan.trigger';
const PLAN_MODEL_ATTRIBUTE = 'plan.model';
const PLAN_FLAVOR_ATTRIBUTE = 'plan.flavor';
const MODEL_NOT_FOUND_REASON = 'not_found';
const MODEL_UNAUTHENTICATED_REASON = 'unauthenticated';
const MODEL_RESTORE_FAILED_REASON = 'restore_failed';
const DEBUG_EVIDENCE_MAX_BYTES = 32 * 1024;
const DEBUG_EVIDENCE_MAX_TEXT_BYTES = 4 * 1024;
const DEBUG_EVIDENCE_MAX_ITEMS = 32;
const DEBUG_DIAGNOSTIC_TOOLS = new Set<string>();
export const WRITE_PLAN_TIMEOUT_MS = 5_000;
const EXIT_PLAN_MODE_CHOICE = 'Exit plan mode and start implementation';
const CONTINUE_PLANNING_CHOICE = 'Continue planning';
const EXIT_PLAN_DECISION = 'exit';
const CONTINUE_PLAN_DECISION = 'continue';
const PLAN_REVIEW_PROMPT = [
  'Plan complete. What would you like to do?',
  `  1. ${EXIT_PLAN_MODE_CHOICE}`,
  `  2. ${CONTINUE_PLANNING_CHOICE}`,
  '  Type something.',
].join('\n');
const PLAN_REVIEW_NARRATION = `Plan complete. What would you like to do? Options: 1, ${EXIT_PLAN_MODE_CHOICE}; 2, ${CONTINUE_PLANNING_CHOICE}. Please choose one option. You may also answer in your own words.`;
const PLAN_REVIEW_NARRATION_REQUEST = createNarrationRequest(PLAN_REVIEW_NARRATION)!;
const PLAN_REVIEW_WAIT_MESSAGE =
  "The choices were spoken through autonomous voice. Stop now and wait for the user's next message; it will arrive as an ordinary user message.";
const PLAN_MODE_PARENT_TOOLS = new Set([
  'add_directory',
  ASK_USER_TOOL,
  BASH_TOOL,
  COMPLETE_PLAN_TOOL,
  FIND_TOOL,
  GREP_TOOL,
  'intercom',
  LIST_TOOL,
  MINOR_MODE_TOOL_NAME,
  ...VOICE_MODE_TOOL_NAMES,
  READ_TOOL,
  'search_external_files',
  SUBAGENT_TOOL,
  'subagent_supervisor',
  'subagent_wait',
  TASK_TOOL,
  WRITE_PLAN_TOOL,
]);
const PLAN_MODE_EXCLUDED_TOOLS = new Set(['edit', 'write', MCP_TOOL]);
const PLAN_MODE_EXPLORATION_TOOLS = [READ_TOOL, BASH_TOOL, GREP_TOOL, FIND_TOOL, LIST_TOOL] as const;
const CHILD_EXPLORATION_TOOLS = [...PLAN_MODE_EXPLORATION_TOOLS, MCP_TOOL] as const;
const PLAN_MODE_TRIGGER_LEADER = 'leader' as const;
const PLAN_MODE_TRIGGER_SESSION_RESTORE = 'session_restore' as const;
const PLAN_MODE_TRIGGER_PLAN_APPROVED = 'plan_approved' as const;
const PLAN_MODE_TRIGGER_SESSION_SHUTDOWN = 'session_shutdown' as const;
const PLAN_MODE_TRIGGER_VOICE_TOOL = 'voice_tool' as const;
const PLAN_STATE_VERSION = 2 as const;
const VALID_THINKING_LEVELS: readonly PlanningThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const VALID_FABLE_STAGES: readonly FableStage[] = [
  'idle',
  'draft',
  'review',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];
const PLAN_VOICE_SOURCE = '@agimon-ai/doompi-plan';
const PLAN_VOICE_ACTIVATE_ID = 'plan-activate';
const PLAN_VOICE_EXIT_ID = 'plan-exit';
const PLAN_VOICE_ACTIVATE_NAME = 'activate_plan';
const PLAN_VOICE_EXIT_NAME = 'exit_plan';
const PLAN_VOICE_FLAVORS = ['normal', 'debug', 'fable'] as const;
const PLAN_VOICE_FLAVOR_SCHEMA = { type: 'string', enum: [...PLAN_VOICE_FLAVORS] } as const;
const PLAN_VOICE_ACTIVATE_INPUT_SCHEMA = {
  type: 'object',
  properties: { flavor: PLAN_VOICE_FLAVOR_SCHEMA },
  required: ['flavor'],
  additionalProperties: false,
} as const;
const PLAN_VOICE_EXIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;
const PLAN_VOICE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    active: { type: 'boolean' },
    flavor: { anyOf: [{ ...PLAN_VOICE_FLAVOR_SCHEMA }, { type: 'null' }] },
    changed: { type: 'boolean' },
  },
  required: ['active', 'flavor', 'changed'],
  additionalProperties: false,
} as const;
const PLAN_TRANSIENT_TOOL_NAMES = new Set([
  COMPLETE_PLAN_TOOL,
  WRITE_PLAN_TOOL,
  RECORD_DEBUG_EVIDENCE_TOOL,
  RUN_FABLE_PLAN_TOOL,
  MINOR_MODE_TOOL_NAME,
  ...VOICE_MODE_TOOL_NAMES,
]);

export type { PlanningFlavor } from './prompts.ts';

export interface ModelIdentity {
  provider: string;
  id: string;
}

export interface PlanSnapshot {
  tools: string[];
  model?: ModelIdentity;
  thinking: PlanningThinkingLevel;
}

interface PersistedPlanModeState {
  version: typeof PLAN_STATE_VERSION;
  activeFlavor?: PlanningFlavor;
  originalSnapshot?: PlanSnapshot;
  planId?: string;
  interruptedFableStage?: FableStage;
}

interface PlanDocument {
  content: string;
  path: string;
  sessionId: string;
  planId?: string;
  title: string;
  writtenAt: string;
}

type PlanWritePhase = 'checking' | 'writing';

/** Why plan mode changed state, so the sink can tell a user toggle from a session restore. */
type PlanModeTrigger =
  | typeof PLAN_MODE_TRIGGER_LEADER
  | typeof PLAN_MODE_TRIGGER_SESSION_RESTORE
  | typeof PLAN_MODE_TRIGGER_PLAN_APPROVED
  | typeof PLAN_MODE_TRIGGER_SESSION_SHUTDOWN
  | typeof PLAN_MODE_TRIGGER_VOICE_TOOL;

export interface PlanModeExtensionOptions {
  fableBroker?: FablePlanBroker;
  debugDiagnosticTools?: readonly string[];
  doomIntegrations?: boolean;
}

interface PlanVoiceReviewServices {
  readonly modes: Pick<MinorModeCatalogService, 'list'>;
  readonly narration: Pick<DoomNarrationService, 'request'>;
}

export function planTitleSlug(markdown: string): string {
  const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1] ?? DEFAULT_PLAN_TITLE;
  return (
    heading
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PLAN_TITLE_MAX_LENGTH) || DEFAULT_PLAN_TITLE
  );
}

export function planSessionIdentifier(sessionId: string): string {
  const readable = encodeURIComponent(sessionId).slice(0, SESSION_ID_MAX_LENGTH) || 'session';
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `${readable}--${digest}`;
}

export function createPlanIdentifier(now = new Date(), id = randomUUID()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}--${id}`;
}

export function visiblePlanForToolCall(entries: readonly unknown[], toolCallId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (candidate.type !== 'message' || candidate.message?.role !== 'assistant') continue;
    if (!Array.isArray(candidate.message.content)) continue;

    const toolIndex = candidate.message.content.findIndex((block) => {
      if (!block || typeof block !== 'object') return false;
      const content = block as { type?: string; id?: string; name?: string };
      return content.type === 'toolCall' && content.id === toolCallId && content.name === WRITE_PLAN_TOOL;
    });
    if (toolIndex < 0) continue;

    const plan = candidate.message.content
      .slice(0, toolIndex)
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return [];
        const content = block as { type?: string; text?: unknown };
        return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
      })
      .join('\n\n')
      .trim();
    return plan || undefined;
  }
  return undefined;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Plan write cancelled.');
}

async function waitForAbortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

type MutableSubagentStep = {
  model?: string;
  output?: string | boolean;
  progress?: boolean;
  worktree?: boolean;
  parallel?: MutableSubagentStep | MutableSubagentStep[];
};

type MutableSubagentRunRequest = {
  [key: string]: unknown;
  model?: string;
};

type MutableSubagentInput = MutableSubagentStep & {
  action?: string;
  artifacts?: boolean;
  outputSchema?: Record<string, unknown>;
  share?: boolean;
  tasks?: MutableSubagentStep[];
  chain?: MutableSubagentStep[];
  chainDir?: string;
  sessionDir?: string;
  requests?: MutableSubagentRunRequest[];
};

type MutableTaskAssignment = {
  [key: string]: unknown;
  model?: string;
};

type MutableTaskInput = {
  action?: string;
  assignments?: MutableTaskAssignment[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseModelIdentity(value: unknown): ModelIdentity | undefined {
  if (!isRecord(value) || !isString(value.provider) || !isString(value.id)) return undefined;
  if (!value.provider || !value.id || value.provider.length > 128 || value.id.length > 128) return undefined;
  return { provider: value.provider, id: value.id };
}

function parseThinkingLevel(value: unknown): PlanningThinkingLevel | undefined {
  return isString(value) && VALID_THINKING_LEVELS.includes(value as PlanningThinkingLevel)
    ? (value as PlanningThinkingLevel)
    : undefined;
}

function parseFableStage(value: unknown): FableStage | undefined {
  return isString(value) && VALID_FABLE_STAGES.includes(value as FableStage) ? (value as FableStage) : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => !isString(item))) return undefined;
  return value.map((item) => item);
}

function parsePlanSnapshot(value: unknown): PlanSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const tools = parseStringArray(value.tools);
  const thinking = parseThinkingLevel(value.thinking);
  if (!tools || thinking === undefined) return undefined;
  const model = value.model === undefined ? undefined : parseModelIdentity(value.model);
  if (value.model !== undefined && !model) return undefined;
  return { tools, ...(model ? { model } : {}), thinking };
}

function parsePlanningFlavor(value: unknown): PlanningFlavor | undefined {
  return value === 'normal' || value === 'debug' || value === 'fable' ? value : undefined;
}

function parseVersionedPlanState(value: Record<string, unknown>): PersistedPlanModeState | undefined {
  if (value.version !== PLAN_STATE_VERSION) return undefined;
  const activeFlavor = value.activeFlavor === undefined ? undefined : parsePlanningFlavor(value.activeFlavor);
  if (value.activeFlavor !== undefined && !activeFlavor) return undefined;
  const originalSnapshot = value.originalSnapshot === undefined ? undefined : parsePlanSnapshot(value.originalSnapshot);
  if (value.originalSnapshot !== undefined && !originalSnapshot) return undefined;
  const planId = value.planId === undefined ? undefined : isString(value.planId) ? value.planId : undefined;
  if (value.planId !== undefined && planId === undefined) return undefined;
  const interruptedFableStage =
    value.interruptedFableStage === undefined ? undefined : parseFableStage(value.interruptedFableStage);
  if (value.interruptedFableStage !== undefined && !interruptedFableStage) return undefined;
  return {
    version: PLAN_STATE_VERSION,
    ...(activeFlavor ? { activeFlavor } : {}),
    ...(originalSnapshot ? { originalSnapshot } : {}),
    ...(planId ? { planId } : {}),
    ...(interruptedFableStage ? { interruptedFableStage } : {}),
  };
}

function parseLegacyPlanState(value: Record<string, unknown>): PersistedPlanModeState | undefined {
  if (value.enabled !== true && value.enabled !== false) return undefined;
  const tools = value.toolsBeforePlanMode === undefined ? undefined : parseStringArray(value.toolsBeforePlanMode);
  if (value.toolsBeforePlanMode !== undefined && !tools) return undefined;
  const model = value.modelBeforePlanMode === undefined ? undefined : parseModelIdentity(value.modelBeforePlanMode);
  if (value.modelBeforePlanMode !== undefined && !model) return undefined;
  const thinking =
    value.thinkingBeforePlanMode === undefined ? undefined : parseThinkingLevel(value.thinkingBeforePlanMode);
  if (value.thinkingBeforePlanMode !== undefined && thinking === undefined) return undefined;
  const planId = value.planId === undefined ? undefined : isString(value.planId) ? value.planId : undefined;
  if (value.planId !== undefined && planId === undefined) return undefined;
  const originalSnapshot =
    tools && thinking !== undefined ? { tools, ...(model ? { model } : {}), thinking } : undefined;
  return {
    version: PLAN_STATE_VERSION,
    ...(value.enabled ? { activeFlavor: 'normal' as const } : {}),
    ...(originalSnapshot ? { originalSnapshot } : {}),
    ...(planId ? { planId } : {}),
  };
}

export function parsePersistedPlanState(value: unknown): PersistedPlanModeState | undefined {
  if (!isRecord(value)) return undefined;
  return parseVersionedPlanState(value) ?? parseLegacyPlanState(value);
}

function parsePlanDocument(value: unknown): PlanDocument | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.content) || !isString(value.path) || !isString(value.sessionId) || !isString(value.title)) {
    return undefined;
  }
  if (!isString(value.writtenAt)) return undefined;
  const planId = value.planId === undefined ? undefined : isString(value.planId) ? value.planId : undefined;
  if (value.planId !== undefined && planId === undefined) return undefined;
  return {
    content: value.content,
    path: value.path,
    sessionId: value.sessionId,
    ...(planId ? { planId } : {}),
    title: value.title,
    writtenAt: value.writtenAt,
  };
}

function boundedDebugText(value: unknown, field: string, required: boolean): string {
  if (!isString(value)) throw new Error(`${field} must be a string.`);
  const text = value.trim();
  if (required && !text) throw new Error(`${field} must not be empty.`);
  if (Buffer.byteLength(text, 'utf8') > DEBUG_EVIDENCE_MAX_TEXT_BYTES) {
    throw new Error(`${field} exceeds the bounded debug evidence limit.`);
  }
  return text;
}

function boundedDebugList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > DEBUG_EVIDENCE_MAX_ITEMS) {
    throw new Error(`${field} must be a bounded string array.`);
  }
  return value.map((item, index) => boundedDebugText(item, `${field}[${index}]`, false));
}

function optionalDebugText(value: unknown, field: string): string {
  return value === undefined ? '' : boundedDebugText(value, field, false);
}

function optionalDebugList(value: unknown, field: string): string[] {
  return value === undefined ? [] : boundedDebugList(value, field);
}

function assertExactObjectKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${field} contains unsupported field '${unexpected}'.`);
}

export function parseDebugEvidencePacket(value: unknown): DebugEvidencePacket {
  if (!isRecord(value)) throw new Error('Debug evidence must be an object.');
  assertExactObjectKeys(
    value,
    [
      'issue',
      'expectedBehavior',
      'reproductionAttempt',
      'actualBehavior',
      'logs',
      'correlatedTraceEvidence',
      'processOutput',
      'browserConsoleEvidence',
      'correlationIds',
      'timestamps',
      'verifiedFacts',
      'hypotheses',
      'unavailableEvidence',
    ],
    'Debug evidence',
  );
  const packet: DebugEvidencePacket = {
    issue: boundedDebugText(value.issue, 'issue', true),
    expectedBehavior: optionalDebugText(value.expectedBehavior, 'expectedBehavior'),
    reproductionAttempt: optionalDebugText(value.reproductionAttempt, 'reproductionAttempt'),
    actualBehavior: optionalDebugText(value.actualBehavior, 'actualBehavior'),
    logs: optionalDebugList(value.logs, 'logs'),
    correlatedTraceEvidence: optionalDebugList(value.correlatedTraceEvidence, 'correlatedTraceEvidence'),
    processOutput: optionalDebugList(value.processOutput, 'processOutput'),
    browserConsoleEvidence: optionalDebugList(value.browserConsoleEvidence, 'browserConsoleEvidence'),
    correlationIds: optionalDebugList(value.correlationIds, 'correlationIds'),
    timestamps: optionalDebugList(value.timestamps, 'timestamps'),
    verifiedFacts: optionalDebugList(value.verifiedFacts, 'verifiedFacts'),
    hypotheses: optionalDebugList(value.hypotheses, 'hypotheses'),
    unavailableEvidence: optionalDebugList(value.unavailableEvidence, 'unavailableEvidence'),
  };
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > DEBUG_EVIDENCE_MAX_BYTES) {
    throw new Error('Debug evidence exceeds the bounded packet size.');
  }
  return packet;
}

export function planModeTools(activeTools: string[], availableTools: string[]): string[] {
  const available = new Set(availableTools);
  const retained = activeTools.filter((name) => PLAN_MODE_PARENT_TOOLS.has(name) && available.has(name));
  const unrelated = activeTools.filter(
    (name) =>
      !PLAN_MODE_PARENT_TOOLS.has(name) &&
      !PLAN_MODE_EXCLUDED_TOOLS.has(name) &&
      !PLAN_TRANSIENT_TOOL_NAMES.has(name) &&
      available.has(name),
  );
  const exploration = PLAN_MODE_EXPLORATION_TOOLS.filter((name) => available.has(name));
  const planTools = [COMPLETE_PLAN_TOOL, TASK_TOOL, WRITE_PLAN_TOOL].filter((name) => available.has(name));
  return [...new Set([...retained, ...unrelated, ...exploration, ...planTools])];
}

function planningToolsForFlavor(
  snapshotTools: string[],
  liveTools: string[],
  availableTools: string[],
  flavor: PlanningFlavor,
  diagnosticTools: ReadonlySet<string>,
): string[] {
  const available = new Set(availableTools);
  const liveUnrelatedTools = liveTools.filter(
    (name) =>
      !PLAN_MODE_PARENT_TOOLS.has(name) && !PLAN_MODE_EXCLUDED_TOOLS.has(name) && !PLAN_TRANSIENT_TOOL_NAMES.has(name),
  );
  const activeTools = [...new Set([...snapshotTools, ...liveUnrelatedTools])];
  const base = planModeTools(
    activeTools.filter((name) => !PLAN_TRANSIENT_TOOL_NAMES.has(name)),
    availableTools,
  );
  const extras =
    flavor === 'debug' ? [RECORD_DEBUG_EVIDENCE_TOOL, ...diagnosticTools].filter((name) => available.has(name)) : [];
  if (flavor === 'fable' && available.has(RUN_FABLE_PLAN_TOOL)) extras.push(RUN_FABLE_PLAN_TOOL);
  for (const name of [MINOR_MODE_TOOL_NAME, ...VOICE_MODE_TOOL_NAMES]) {
    if (liveTools.includes(name) && available.has(name)) extras.push(name);
  }
  return [...new Set([...base, ...extras])];
}

function restoreSnapshotTools(snapshotTools: string[], liveTools: string[], availableTools: string[]): string[] {
  const available = new Set(availableTools);
  const live = new Set(liveTools);
  const restored = snapshotTools.filter(
    (name) => !PLAN_TRANSIENT_TOOL_NAMES.has(name) && available.has(name) && (name !== ASK_USER_TOOL || live.has(name)),
  );
  const unrelatedLiveTools = liveTools.filter(
    (name) =>
      !PLAN_MODE_PARENT_TOOLS.has(name) &&
      !PLAN_MODE_EXCLUDED_TOOLS.has(name) &&
      !PLAN_TRANSIENT_TOOL_NAMES.has(name) &&
      available.has(name),
  );
  const liveToolsToRestore = [MINOR_MODE_TOOL_NAME, ...VOICE_MODE_TOOL_NAMES].filter(
    (name) => live.has(name) && available.has(name),
  );
  return [...new Set([...restored, ...unrelatedLiveTools, ...liveToolsToRestore])];
}

function disableStepOutput(step: MutableSubagentStep): void {
  step.output = false;
  step.progress = false;
  step.worktree = false;
  if (Array.isArray(step.parallel)) {
    for (const child of step.parallel) disableStepOutput(child);
  } else if (step.parallel) {
    disableStepOutput(step.parallel);
  }
}

export function constrainSubagentInput(input: MutableSubagentInput): void {
  if (input.action !== undefined) {
    if (isSubagentAction(input.action) && subagentActionAcceptsField(input.action, 'artifacts')) {
      input.artifacts = false;
    }
    return;
  }

  input.artifacts = false;
  input.output = false;
  input.share = false;
  input.progress = false;
  input.worktree = false;
  delete input.chainDir;
  delete input.outputSchema;
  delete input.sessionDir;
  for (const task of input.tasks ?? []) disableStepOutput(task);
  for (const step of input.chain ?? []) disableStepOutput(step);
}

export function planningSubagentModel(
  config: PlanningAgentConfig | undefined,
  currentModel: ModelIdentity | undefined,
): string | undefined {
  if (!config?.model && !config?.thinking) return undefined;
  const baseModel = config.model ?? (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
  if (!baseModel) return undefined;
  if (!config.thinking) return baseModel;
  return `${baseModel.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, '')}:${config.thinking}`;
}

export function configurePlanningSubagentInput(input: MutableSubagentInput, model: string): void {
  if (input.action !== 'run') return;
  for (const request of input.requests ?? []) request.model = model;
}

export function configurePlanningTaskInput(input: MutableTaskInput, model: string): void {
  if (input.action !== 'assign') return;
  for (const assignment of input.assignments ?? []) assignment.model = model;
}

export function isBlockedSubagentManagementAction(action: string | undefined): boolean {
  return new Set([
    'append-step',
    'create',
    'delete',
    'disable',
    'eject',
    'enable',
    'grant-spawn-budget',
    'reset',
    'schedule',
    'schedule-cancel',
    'update',
    'watchdog.configure',
  ]).has(action ?? '');
}

function resolvePlanningModel(
  modelSpec: string,
  ctx: ExtensionContext,
): NonNullable<ExtensionContext['model']> | undefined {
  const separator = modelSpec.indexOf('/');
  if (separator > 0) {
    return ctx.modelRegistry.find(modelSpec.slice(0, separator), modelSpec.slice(separator + 1));
  }

  const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === modelSpec);
  return (
    matches.find((model) => model.provider === ctx.model?.provider) ?? (matches.length === 1 ? matches[0] : undefined)
  );
}

export type PlanningConfigProvider = () => PlanningModeConfig | undefined;

/** Reads Doom settings from disk so each plan-mode activation sees current configuration. */
export function loadPlanningModeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
): PlanningModeConfig | undefined {
  return loadDoomConfig(loadHarnessState(environment).state.root ?? currentDirectory).modes?.planning;
}

/**
 * The plan menu as it stands with the mode on or off.
 *
 * One entry on `e` rather than an enter row beside an exit row: only one of the
 * two ever does anything, and a menu that prints both makes the reader check the
 * mode line to find out which. `d` and `f` stay on their own keys because they
 * are flavors of the same mode, reachable whether or not it is already on.
 */
function planLeaderBindings(active: boolean): LeaderBinding[] {
  const group = {
    key: 'p',
    label: 'plan',
    detail: 'read-only planning modes',
    order: PLAN_LEADER_GROUP_ORDER,
  } as const;
  return [
    active
      ? {
          id: 'plan.exit',
          path: [group, { key: 'e', label: 'exit', detail: 'restore and exit', tone: 'exit' }],
          action: { name: 'plan.exit' },
        }
      : {
          id: 'plan.normal',
          path: [group, { key: 'e', label: 'enter', detail: 'read-only planning' }],
          action: { name: 'plan.normal' },
        },
    {
      id: 'plan.debug',
      path: [group, { key: 'd', label: 'debug', detail: 'adaptive debug planning' }],
      action: { name: 'plan.debug' },
    },
    {
      id: 'plan.fable',
      path: [group, { key: 'f', label: 'fable', detail: 'repository-aware draft' }],
      action: { name: 'plan.fable' },
    },
  ];
}

export function planModeExtension(
  cordis: Context,
  pi: ExtensionAPI,
  planningConfigProvider: PlanningConfigProvider = loadPlanningModeConfig,
  telemetry: PlanTelemetry = createPlanTelemetry(),
  options: PlanModeExtensionOptions = {},
): void {
  let active = true;
  let sessionGeneration = 0;
  let shutdownPromise: Promise<void> | undefined;
  let modeOwner: Pick<MinorModeOwnerHandle, 'publish' | 'dispose'> | undefined;
  let leaderContribution: DoomLeaderContributionHandle | undefined;
  let planConfigContribution: DoomConfigContributionHandle | undefined;
  let disposeLeaderActions: (() => void) | undefined;
  let planConfigNotice: string | undefined;
  /** The session context, kept only to read its model registry for the config panel. */
  let configSessionCtx: ExtensionContext | undefined;
  const sessionModels = (): PlanModelChoice[] => {
    const registry = configSessionCtx?.modelRegistry;
    if (!registry) return [];
    return registry
      .getAvailable()
      .filter((model) => registry.hasConfiguredAuth(model))
      .map((model) => ({ provider: model.provider, id: model.id }));
  };

  let enabled = false;
  let activeFlavor: PlanningFlavor | undefined;
  let planSnapshot: PlanSnapshot | undefined;
  let activePlanningConfig: PlanningModeConfig | undefined;
  let capabilityCeiling: SubagentPolicyHandle | undefined;
  let subagentPolicyService: DoomSubagentPolicyService | undefined;
  let fablePlanService: DoomFablePlanService | undefined;
  let currentPlan: PlanDocument | undefined;
  let activePlanId: string | undefined;
  let planReadyForReview = false;
  let awaitingVoicePlanDecision = false;
  let voiceReviewServices: PlanVoiceReviewServices | undefined;
  let debugEvidence: DebugEvidencePacket | undefined;
  let fableStage: FableStage = 'idle';
  let interruptedFableStage: FableStage | undefined;
  let activeContext: ExtensionContext | undefined;
  let activeFableRun: Promise<FablePlanResult> | undefined;
  let fableFlow: ReturnType<typeof createFablePlanFlow> | undefined;
  let transitionQueue: Promise<void> = Promise.resolve();
  const doomIntegrations = options.doomIntegrations ?? true;
  const diagnosticTools = new Set(options.debugDiagnosticTools ?? DEBUG_DIAGNOSTIC_TOOLS);
  const runtimeAbortController = new AbortController();
  cordis.effect(() => () => shutdownPlanRuntime(), `${PLAN_LEADER_SOURCE}/runtime`);
  const fableBroker: FablePlanBroker = options.fableBroker ?? {
    start: (request, signal) => {
      const service = fablePlanService;
      if (!service) throw new Error('The session-bound Fable broker is unavailable.');
      return service.start(request, signal);
    },
    cancel: (operationId, reason) => {
      fablePlanService?.cancel({ requester: CONTRACT_FABLE_PLAN_REQUESTER, operationId, reason });
    },
  };
  const isFableBrokerAvailable = (): boolean => options.fableBroker !== undefined || fablePlanService !== undefined;

  cordis.inject([DOOM_FABLE_PLAN_SERVICE], (serviceContext) => {
    const service = readDoomFablePlanService(serviceContext);
    if (!service) return undefined;
    fablePlanService = service;
    return () => {
      if (fablePlanService !== service) return;
      fablePlanService = undefined;
      if (activeFableRun) fableFlow?.cancel('The Team Fable service was unloaded.');
    };
  });

  cordis.inject([DOOM_SUBAGENT_POLICY_SERVICE], (serviceContext) => {
    const service = readDoomSubagentPolicyService(serviceContext);
    if (!service) return undefined;
    subagentPolicyService = service;
    updateCapabilityCeiling();
    return () => {
      if (subagentPolicyService !== service) return;
      capabilityCeiling?.dispose();
      capabilityCeiling = undefined;
      subagentPolicyService = undefined;
    };
  });
  if (doomIntegrations) {
    cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE, DOOM_NARRATION_SERVICE], (voiceContext) => {
      const services: PlanVoiceReviewServices = {
        modes: requireMinorModeCatalog(voiceContext),
        narration: requireDoomNarrationService(voiceContext),
      };
      voiceReviewServices = services;
      return () => {
        if (voiceReviewServices === services) voiceReviewServices = undefined;
      };
    });
    cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
      const owner = registerMinorModeOwner<ExtensionContext>(requireMinorModeCatalog(modeContext), {
        descriptor: {
          source: PLAN_LEADER_SOURCE,
          id: MODE_ID,
          label: MODE_LABEL,
          description: 'Read-only planning with normal, debug, and Fable flavors.',
          order: MODE_ORDER,
          actions: [
            {
              id: MODE_ACTIVATE_ACTION,
              label: 'Activate',
              description: 'Activate plan mode or switch its planning flavor.',
              contexts: ['tui', 'headless'],
              parameters: [
                {
                  name: 'flavor',
                  label: 'Flavor',
                  kind: 'enum',
                  required: true,
                  choices: [
                    { value: 'normal', label: 'Normal' },
                    { value: 'debug', label: 'Debug' },
                    { value: 'fable', label: 'Fable' },
                  ],
                },
              ],
            },
            {
              id: MODE_DEACTIVATE_ACTION,
              label: 'Deactivate',
              description: 'Exit plan mode and restore the previous agent configuration.',
              contexts: ['tui', 'headless'],
              parameters: [],
            },
          ],
        },
        initialState: currentPlanModeState(),
        async handleAction(actionId, argumentsValue, execution) {
          if (!active) throw new Error('Plan runtime is disposed.');
          if (actionId === MODE_ACTIVATE_ACTION) {
            const flavor = argumentsValue.flavor;
            if (flavor !== 'normal' && flavor !== 'debug' && flavor !== 'fable') {
              throw new Error('A valid plan flavor is required.');
            }
            await queueTransition(() => activateFlavor(execution.context, flavor, PLAN_MODE_TRIGGER_LEADER, false));
            return { message: `Plan mode is active with the ${flavor} flavor.` };
          }
          if (actionId === MODE_DEACTIVATE_ACTION) {
            const exited = await queueTransition(() => exitPlanMode(execution.context, PLAN_MODE_TRIGGER_LEADER));
            return { message: exited ? 'Plan mode deactivated.' : 'Plan mode remains active.' };
          }
          throw new Error(`Unknown plan mode action: ${actionId}`);
        },
        onError: (error) => void telemetry.recordError(PLAN_EVENT.configLoadFailed, error),
      });
      modeOwner = owner;
      return () => {
        owner.dispose();
        if (modeOwner === owner) modeOwner = undefined;
      };
    });
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const hub = requireDoomUiHub(uiContext);
      const leader = hub.registerLeader({
        source: PLAN_LEADER_SOURCE,
        bindings: planLeaderBindings(enabled),
      });
      const config = hub.registerConfig<ExtensionContext>({
        source: PLAN_LEADER_SOURCE,
        // Read at publish time, not cached: plan mode re-reads this file on every
        // activation anyway, so the panel should show whatever is on disk now.
        listSections: () => {
          // Read from the live session so the list is the models this session
          // can actually switch to, not a table compiled into the package.
          const models = sessionModels();
          try {
            return planConfigSections(planningConfigProvider(), planConfigNotice, models);
          } catch (error) {
            // A malformed config file must not take session start down with it. The
            // panel is where someone would go to repair it, so it has to still draw.
            return planConfigSections(undefined, error instanceof Error ? error.message : String(error), models);
          }
        },
        handlers: {
          [CONFIG_ACTION.set]: async ({ fieldId, value }) => {
            const setting = planSettingByFieldId(fieldId);
            if (!setting || !value) return;
            planConfigNotice = undefined;
            await setDoomConfigValue(globalDoomConfigPath(), [...setting.keyPath], value);
          },
          [CONFIG_ACTION.clear]: async ({ fieldId }) => {
            const setting = planSettingByFieldId(fieldId);
            if (!setting) return;
            planConfigNotice = undefined;
            await unsetDoomConfigValue(globalDoomConfigPath(), [...setting.keyPath]);
          },
        },
        onError: (error) => {
          if (active) planConfigNotice = error instanceof Error ? error.message : String(error);
        },
      });
      leaderContribution = leader;
      planConfigContribution = config;
      return () => {
        config.dispose();
        leader.dispose();
        if (planConfigContribution === config) planConfigContribution = undefined;
        if (leaderContribution === leader) leaderContribution = undefined;
      };
    });
  }

  function assertRuntimeActive(generation = sessionGeneration): void {
    if (!active || generation !== sessionGeneration) throw new Error('Plan runtime is disposed or stale.');
  }

  async function requestVoicePlanReview(): Promise<boolean> {
    const services = voiceReviewServices;
    if (
      !services ||
      !services.modes
        .list()
        .some(
          (record) =>
            record.descriptor.source === DOOM_VOICE_SOURCE &&
            record.descriptor.id === DOOM_VOICE_AUTO_MODE_ID &&
            record.state.activation === 'active',
        )
    ) {
      return false;
    }
    try {
      await services.narration.request(PLAN_REVIEW_NARRATION_REQUEST);
      return true;
    } catch (error) {
      void telemetry.recordWarning(PLAN_EVENT.planReviewCompleted, error, {
        'plan.outcome': 'narration_failed',
      });
      return false;
    }
  }

  function voicePlanReviewResult(): {
    readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
    readonly details: {
      readonly answers: readonly [];
      readonly awaitingResponse: true;
      readonly cancelled: false;
      readonly delivery: 'voice';
      readonly voicePrompt: string;
    };
    readonly terminate: true;
  } {
    return {
      content: [{ type: 'text', text: `${PLAN_REVIEW_PROMPT}\n\n${PLAN_REVIEW_WAIT_MESSAGE}` }],
      details: {
        answers: [],
        awaitingResponse: true,
        cancelled: false,
        delivery: 'voice',
        voicePrompt: PLAN_REVIEW_PROMPT,
      },
      terminate: true,
    };
  }

  function shutdownPlanRuntime(): Promise<void> {
    shutdownPromise ??= (async () => {
      active = false;
      sessionGeneration += 1;
      runtimeAbortController.abort(new Error('Plan runtime is shutting down.'));
      const cleanupContext = activeContext;
      const cleanupSnapshot = planSnapshot;
      const cleanupErrors: unknown[] = [];
      fableFlow?.cancel('Plan runtime is shutting down.');
      const pendingWork = [transitionQueue, ...(activeFableRun ? [activeFableRun] : [])];
      const settledWork = await Promise.allSettled(pendingWork);
      for (const result of settledWork) {
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
      }

      if (enabled && cleanupSnapshot && cleanupContext) {
        try {
          const restored = await restoreMainAgent(cleanupContext, cleanupSnapshot, true);
          if (restored) {
            pi.setActiveTools(
              restoreSnapshotTools(
                cleanupSnapshot.tools,
                pi.getActiveTools(),
                pi.getAllTools().map((tool) => tool.name),
              ),
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      const disposers = [
        () => capabilityCeiling?.dispose(),
        () => disposeLeaderActions?.(),
        () => planConfigContribution?.dispose(),
        () => leaderContribution?.dispose(),
        () => modeOwner?.dispose(),
      ];
      for (const disposeResource of disposers) {
        try {
          disposeResource();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      capabilityCeiling = undefined;
      voiceReviewServices = undefined;
      disposeLeaderActions = undefined;
      planConfigContribution = undefined;
      leaderContribution = undefined;
      modeOwner = undefined;
      activeFableRun = undefined;
      activeContext = undefined;
      awaitingVoicePlanDecision = false;
      enabled = false;
      activeFlavor = undefined;
      planSnapshot = undefined;
      activePlanningConfig = undefined;
      try {
        await telemetry.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Plan runtime cleanup failed.');
    })();
    return shutdownPromise;
  }

  /** Identical bindings are dropped by the handle, so this can ride along with every state change. */
  function updateLeader(): void {
    if (!active) return;
    leaderContribution?.update(planLeaderBindings(enabled));
  }

  function currentPlanModeState(): MinorModeState {
    const flavor = activeFlavor;
    const stage = flavor === 'fable' && fableStage !== 'idle' ? ` · ${fableStage}` : '';
    return {
      activation: enabled ? 'active' : 'inactive',
      condition: fableStage === 'failed' ? 'failed' : fableStage === 'interrupted' ? 'degraded' : 'ready',
      ...(enabled && flavor
        ? { detail: `${flavor}${stage} - ${READ_ONLY_DETAIL}`, color: WARNING_STYLE, modelContextVariant: flavor }
        : {}),
      actions: [
        { id: MODE_ACTIVATE_ACTION, enabled: true },
        ...(enabled
          ? [{ id: MODE_DEACTIVATE_ACTION, enabled: true } as const]
          : [{ id: MODE_DEACTIVATE_ACTION, enabled: false, disabledReason: 'Plan mode is inactive.' } as const]),
      ],
    };
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!active) return;
    updateLeader();
    const flavor = activeFlavor;
    const status = enabled && flavor ? `plan:${flavor}` : undefined;
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, status ? ctx.ui.theme.fg(WARNING_STYLE, status) : undefined);
    modeOwner?.publish(currentPlanModeState());
  }

  function updateCapabilityCeiling(): void {
    if (!active || !doomIntegrations || !enabled || !activeFlavor || !activeContext) return;
    const allowedTools = [...CHILD_EXPLORATION_TOOLS];
    const allowedExternalProfiles = activeFlavor === 'fable' ? [FABLE_PLAN_PROFILE] : [];
    const policy = {
      owner: PLAN_LEADER_SOURCE,
      allowedTools,
      requiredTools: [BASH_TOOL, MCP_TOOL],
      allowMcpTools: true,
      allowedExternalProfiles,
      denyExtensions: false,
    };
    if (capabilityCeiling) capabilityCeiling.update(policy);
    else capabilityCeiling = subagentPolicyService?.register(policy);
  }

  function persistState(): void {
    if (!active) return;
    pi.appendEntry(PLAN_MODE_ENTRY, {
      version: PLAN_STATE_VERSION,
      ...(enabled && activeFlavor ? { activeFlavor } : {}),
      ...(planSnapshot
        ? {
            originalSnapshot: {
              tools: [...planSnapshot.tools],
              ...(planSnapshot.model ? { model: { ...planSnapshot.model } } : {}),
              thinking: planSnapshot.thinking,
            },
          }
        : {}),
      ...(activePlanId ? { planId: activePlanId } : {}),
      ...(interruptedFableStage ? { interruptedFableStage } : {}),
    } satisfies PersistedPlanModeState);
  }

  function reportModelFailure(
    phase: 'apply' | 'restore',
    model: string,
    reason: typeof MODEL_NOT_FOUND_REASON | typeof MODEL_UNAUTHENTICATED_REASON | typeof MODEL_RESTORE_FAILED_REASON,
  ): void {
    void telemetry.recordWarning(PLAN_EVENT.modelResolveFailed, `Planning model ${reason}: ${model}`, {
      [PLAN_MODEL_ATTRIBUTE]: model,
      'plan.model.phase': phase,
      'plan.model.reason': reason,
    });
  }

  async function applyMainPlanningConfig(ctx: ExtensionContext): Promise<void> {
    const generation = sessionGeneration;
    assertRuntimeActive(generation);
    const config = activePlanningConfig?.main;
    if (!config) return;
    if (config.model) {
      const model = resolvePlanningModel(config.model, ctx);
      if (!model) {
        ctx.ui.notify(`Planning model not found: ${config.model}`, WARNING_STYLE);
        reportModelFailure('apply', config.model, MODEL_NOT_FOUND_REASON);
      } else {
        const authenticated = await pi.setModel(model);
        assertRuntimeActive(generation);
        if (!authenticated) {
          ctx.ui.notify(`Planning model is unavailable without authentication: ${config.model}`, WARNING_STYLE);
          reportModelFailure('apply', config.model, MODEL_UNAUTHENTICATED_REASON);
        }
      }
    }
    assertRuntimeActive(generation);
    if (config.thinking) pi.setThinkingLevel(config.thinking);
  }

  async function restoreMainAgent(
    ctx: ExtensionContext,
    snapshot: PlanSnapshot | undefined,
    allowInactive = false,
  ): Promise<boolean> {
    const generation = sessionGeneration;
    if (!allowInactive) assertRuntimeActive(generation);
    if (!snapshot) return false;
    if (snapshot.model) {
      const identity = `${snapshot.model.provider}/${snapshot.model.id}`;
      const model = ctx.modelRegistry.find(snapshot.model.provider, snapshot.model.id);
      if (!model) {
        ctx.ui.notify(`Previous model not found: ${identity}`, WARNING_STYLE);
        reportModelFailure('restore', identity, MODEL_NOT_FOUND_REASON);
        return false;
      }
      try {
        const authenticated = await pi.setModel(model);
        if (!allowInactive) assertRuntimeActive(generation);
        if (!authenticated) {
          ctx.ui.notify(`Previous model is unavailable without authentication: ${identity}`, WARNING_STYLE);
          reportModelFailure('restore', identity, MODEL_UNAUTHENTICATED_REASON);
          return false;
        }
      } catch (error) {
        if (!allowInactive) assertRuntimeActive(generation);
        ctx.ui.notify(`Previous model could not be restored: ${identity}`, WARNING_STYLE);
        reportModelFailure('restore', identity, MODEL_RESTORE_FAILED_REASON);
        void telemetry.recordError(PLAN_EVENT.modelResolveFailed, error, {
          [PLAN_MODEL_ATTRIBUTE]: identity,
          'plan.model.phase': 'restore',
          'plan.model.reason': MODEL_RESTORE_FAILED_REASON,
        });
        return false;
      }
    }
    if (!allowInactive) assertRuntimeActive(generation);
    pi.setThinkingLevel(snapshot.thinking);
    return true;
  }

  function reportCurrentFlavor(ctx: ExtensionContext): void {
    if (enabled && activeFlavor) ctx.ui.notify(`Already in plan:${activeFlavor}.`, INFO_STYLE);
    else ctx.ui.notify('Plan mode is inactive.', INFO_STYLE);
  }

  function queueTransition<T>(transition: () => Promise<T>): Promise<T> {
    const generation = sessionGeneration;
    const run = async (): Promise<T> => {
      assertRuntimeActive(generation);
      const result = await transition();
      assertRuntimeActive(generation);
      return result;
    };
    const queued = transitionQueue.then(run, run);
    transitionQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function cancelFableOperation(reason: string): Promise<void> {
    const generation = sessionGeneration;
    assertRuntimeActive(generation);
    if (!activeFableRun && !fableStage.match(/^(draft|review)$/u)) return;
    if (fableStage === 'draft' || fableStage === 'review') interruptedFableStage = fableStage;
    fableFlow?.cancel(reason);
    const pending = activeFableRun;
    if (pending) {
      try {
        await pending;
        assertRuntimeActive(generation);
      } catch (error) {
        assertRuntimeActive(generation);
        void telemetry.recordError(PLAN_EVENT.modeDisabled, error, {
          [PLAN_FLAVOR_ATTRIBUTE]: 'fable',
          'plan.fable.reason': 'cancel_failed',
        });
      }
    }
    assertRuntimeActive(generation);
    activeFableRun = undefined;
    if (interruptedFableStage) fableStage = 'interrupted';
    if (activeContext) updateStatus(activeContext);
    persistState();
  }

  async function activateFlavor(
    ctx: ExtensionContext,
    flavor: PlanningFlavor,
    trigger: PlanModeTrigger,
    restoring: boolean,
  ): Promise<void> {
    const generation = sessionGeneration;
    assertRuntimeActive(generation);
    activeContext = ctx;
    if (enabled) {
      if (activeFlavor === flavor) {
        reportCurrentFlavor(ctx);
        return;
      }
      if (activeFlavor === 'fable') await cancelFableOperation(`Leaving Fable for plan:${flavor}.`);
      assertRuntimeActive(generation);
      activeFlavor = flavor;
      updateCapabilityCeiling();
      pi.setActiveTools(
        planningToolsForFlavor(
          planSnapshot?.tools ?? [],
          pi.getActiveTools(),
          pi.getAllTools().map((tool) => tool.name),
          flavor,
          diagnosticTools,
        ),
      );
      updateStatus(ctx);
      persistState();
      void telemetry.recordEvent(PLAN_EVENT.modeEnabled, {
        [PLAN_TRIGGER_ATTRIBUTE]: trigger,
        [PLAN_FLAVOR_ATTRIBUTE]: flavor,
        'plan.tool.count': pi.getActiveTools().length,
      });
      return;
    }

    let nextPlanningConfig: PlanningModeConfig | undefined;
    try {
      nextPlanningConfig = planningConfigProvider();
    } catch (error) {
      void telemetry.recordError(PLAN_EVENT.configLoadFailed, error, { [PLAN_TRIGGER_ATTRIBUTE]: trigger });
      throw error;
    }

    if (!restoring) {
      currentPlan = undefined;
      planReadyForReview = false;
      awaitingVoicePlanDecision = false;
      activePlanId = createPlanIdentifier();
      interruptedFableStage = undefined;
      fableStage = 'idle';
    } else {
      activePlanId ??= createPlanIdentifier();
    }
    activePlanningConfig = nextPlanningConfig;
    planSnapshot ??= {
      tools: [...pi.getActiveTools()],
      ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      thinking: pi.getThinkingLevel(),
    };
    enabled = true;
    activeFlavor = flavor;
    pi.setActiveTools(
      planningToolsForFlavor(
        planSnapshot.tools,
        pi.getActiveTools(),
        pi.getAllTools().map((tool) => tool.name),
        flavor,
        diagnosticTools,
      ),
    );
    updateCapabilityCeiling();
    await applyMainPlanningConfig(ctx);
    assertRuntimeActive(generation);
    updateStatus(ctx);
    persistState();
    void telemetry.recordEvent(PLAN_EVENT.modeEnabled, {
      [PLAN_TRIGGER_ATTRIBUTE]: trigger,
      [PLAN_FLAVOR_ATTRIBUTE]: flavor,
      'plan.tool.count': pi.getActiveTools().length,
      ...(activePlanningConfig?.main?.model ? { [PLAN_MODEL_ATTRIBUTE]: activePlanningConfig.main.model } : {}),
      ...(activePlanningConfig?.main?.thinking ? { 'plan.thinking': activePlanningConfig.main.thinking } : {}),
    });
  }

  async function exitPlanMode(ctx: ExtensionContext, trigger: PlanModeTrigger): Promise<boolean> {
    const generation = sessionGeneration;
    assertRuntimeActive(generation);
    if (!enabled) {
      reportCurrentFlavor(ctx);
      return false;
    }
    await cancelFableOperation('Plan mode is exiting.');
    assertRuntimeActive(generation);
    const snapshot = planSnapshot;
    const restored = await restoreMainAgent(ctx, snapshot);
    assertRuntimeActive(generation);
    if (!restored) {
      ctx.ui.notify('Previous model was not restored. Plan mode remains read-only.', WARNING_STYLE);
      updateStatus(ctx);
      persistState();
      void telemetry.recordWarning(PLAN_EVENT.modeDisabled, 'Plan mode restoration failed.', {
        [PLAN_TRIGGER_ATTRIBUTE]: trigger,
        [PLAN_FLAVOR_ATTRIBUTE]: activeFlavor ?? 'unknown',
        'plan.restored': false,
      });
      return false;
    }

    const hadPlan = Boolean(currentPlan);
    pi.setActiveTools(
      restoreSnapshotTools(
        snapshot?.tools ?? [],
        pi.getActiveTools(),
        pi.getAllTools().map((tool) => tool.name),
      ),
    );
    capabilityCeiling?.dispose();
    capabilityCeiling = undefined;
    enabled = false;
    activeFlavor = undefined;
    activePlanningConfig = undefined;
    awaitingVoicePlanDecision = false;
    planSnapshot = undefined;
    debugEvidence = undefined;
    fableStage = 'idle';
    interruptedFableStage = undefined;
    updateStatus(ctx);
    persistState();
    void telemetry.recordEvent(PLAN_EVENT.modeDisabled, {
      [PLAN_TRIGGER_ATTRIBUTE]: trigger,
      [PLAN_FLAVOR_ATTRIBUTE]: 'normal',
      'plan.written': hadPlan,
      'plan.restored': true,
    });
    return true;
  }

  if (doomIntegrations) {
    const assertVoiceTransitionNotCancelled = (signal: AbortSignal): void => {
      assertRuntimeActive();
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Plan voice transition was cancelled.');
      }
    };
    const activatePlanVoiceTool: VoiceToolDefinition<ExtensionContext> = {
      descriptor: {
        source: PLAN_VOICE_SOURCE,
        id: PLAN_VOICE_ACTIVATE_ID,
        name: PLAN_VOICE_ACTIVATE_NAME,
        label: 'Activate Plan',
        description: 'Activate or switch the serialized read-only planning mode flavor.',
        order: 10,
        inputSchema: PLAN_VOICE_ACTIVATE_INPUT_SCHEMA,
        resultSchema: PLAN_VOICE_RESULT_SCHEMA,
      },
      execute(input, execution) {
        const flavor = parsePlanningFlavor(isRecord(input) ? input.flavor : undefined);
        if (!flavor) throw new Error('A valid plan flavor is required.');
        assertVoiceTransitionNotCancelled(execution.signal);
        return queueTransition(async () => {
          assertVoiceTransitionNotCancelled(execution.signal);
          const previousEnabled = enabled;
          const previousFlavor = activeFlavor;
          await activateFlavor(execution.context, flavor, PLAN_MODE_TRIGGER_VOICE_TOOL, false);
          return {
            active: enabled,
            flavor: activeFlavor ?? flavor,
            changed: previousEnabled !== enabled || previousFlavor !== activeFlavor,
          };
        });
      },
    };
    const exitPlanVoiceTool: VoiceToolDefinition<ExtensionContext> = {
      descriptor: {
        source: PLAN_VOICE_SOURCE,
        id: PLAN_VOICE_EXIT_ID,
        name: PLAN_VOICE_EXIT_NAME,
        label: 'Exit Plan',
        description: 'Exit read-only planning mode and restore the previous agent configuration.',
        order: 20,
        inputSchema: PLAN_VOICE_EXIT_INPUT_SCHEMA,
        resultSchema: PLAN_VOICE_RESULT_SCHEMA,
      },
      execute(_input, execution) {
        assertVoiceTransitionNotCancelled(execution.signal);
        return queueTransition(async () => {
          assertVoiceTransitionNotCancelled(execution.signal);
          const previousEnabled = enabled;
          const exited = await exitPlanMode(execution.context, PLAN_MODE_TRIGGER_VOICE_TOOL);
          return {
            active: enabled,
            flavor: activeFlavor ?? null,
            changed: previousEnabled !== enabled || exited,
          };
        });
      },
    };
    cordis.inject([DOOM_VOICE_TOOLS_SERVICE], (voiceContext) => {
      const service = requireDoomVoiceToolsService(voiceContext);
      const activate = service.register(activatePlanVoiceTool);
      const exit = service.register(exitPlanVoiceTool);
      return () => {
        exit.dispose();
        activate.dispose();
      };
    });
  }

  fableFlow = createFablePlanFlow({
    broker: fableBroker,
    isAuthorized: () => active && enabled && activeFlavor === 'fable' && isFableBrokerAvailable(),
    onStage: (stage) => {
      if (!active) return;
      fableStage = stage;
      if (stage === 'completed' || stage === 'failed' || stage === 'cancelled') interruptedFableStage = undefined;
      if (activeContext) updateStatus(activeContext);
      if (enabled) persistState();
    },
    onError: (error) => {
      if (!active) return;
      void telemetry.recordError(PLAN_EVENT.modeEnabled, error, {
        [PLAN_FLAVOR_ATTRIBUTE]: 'fable',
        'plan.fable.reason': 'flow_error',
      });
    },
  });

  pi.registerTool({
    name: RECORD_DEBUG_EVIDENCE_TOOL,
    label: 'Record Debug Evidence',
    description: 'Record optional bounded debug evidence while planning a repository fix.',
    promptSnippet: 'Record the issue and any relevant reproduction, logs, traces, process output, or browser evidence',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string' },
        expectedBehavior: { type: 'string' },
        reproductionAttempt: { type: 'string' },
        actualBehavior: { type: 'string' },
        logs: { type: 'array', items: { type: 'string' } },
        correlatedTraceEvidence: { type: 'array', items: { type: 'string' } },
        processOutput: { type: 'array', items: { type: 'string' } },
        browserConsoleEvidence: { type: 'array', items: { type: 'string' } },
        correlationIds: { type: 'array', items: { type: 'string' } },
        timestamps: { type: 'array', items: { type: 'string' } },
        verifiedFacts: { type: 'array', items: { type: 'string' } },
        hypotheses: { type: 'array', items: { type: 'string' } },
        unavailableEvidence: { type: 'array', items: { type: 'string' } },
      },
      required: ['issue'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      assertRuntimeActive();
      if (!enabled || activeFlavor !== 'debug') {
        return { content: [{ type: 'text', text: 'Debug planning is not active.' }], details: { recorded: false } };
      }
      try {
        debugEvidence = parseDebugEvidencePacket(params);
      } catch (error) {
        void telemetry.recordWarning(PLAN_EVENT.modeEnabled, error, {
          [PLAN_FLAVOR_ATTRIBUTE]: 'debug',
          'plan.debug.reason': 'invalid_evidence',
        });
        throw error;
      }
      if (activeContext) updateStatus(activeContext);
      return {
        content: [{ type: 'text', text: 'Debug evidence recorded as optional planning context.' }],
        details: { recorded: true },
      };
    },
  });

  pi.registerTool({
    name: RUN_FABLE_PLAN_TOOL,
    label: 'Run Fable Plan',
    description: 'Send a bounded, sanitized planning packet to the local Fable broker for one repository-aware draft.',
    promptSnippet: 'Run the local Fable draft with the bounded planning packet',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        verifiedFindings: { type: 'array', items: { type: 'object' } },
        inferredFindings: { type: 'array', items: { type: 'string' } },
        unresolvedQuestions: { type: 'array', items: { type: 'string' } },
        currentPlan: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      const generation = sessionGeneration;
      assertRuntimeActive(generation);
      if (!enabled || activeFlavor !== 'fable') {
        return {
          content: [{ type: 'text', text: 'Fable planning is not active.' }],
          details: { started: false } as Record<string, unknown>,
        };
      }
      if (!isFableBrokerAvailable()) {
        return {
          content: [{ type: 'text', text: 'The local Fable broker is unavailable. Fable planning remains disabled.' }],
          details: { started: false, errorCode: 'broker_unavailable' } as Record<string, unknown>,
        };
      }
      const flow = fableFlow;
      if (!flow) throw new Error('Fable planning flow is unavailable.');
      const operation = flow.run(params, signal);
      activeFableRun = operation;
      try {
        const result = await operation;
        assertRuntimeActive(generation);
        const text = result.draft
          ? `Fable draft:\n${result.draft}`
          : `Fable planning ${result.status}: ${result.errorCode ?? 'no output'}.`;
        return {
          content: [{ type: 'text', text }],
          details: { ...result, started: true } as Record<string, unknown>,
        };
      } finally {
        if (active && generation === sessionGeneration && activeFableRun === operation) activeFableRun = undefined;
      }
    },
  });

  pi.registerTool({
    name: WRITE_PLAN_TOOL,
    label: 'Write Plan',
    description:
      'After presenting the complete implementation plan as Markdown in chat, save that visible plan to a unique Markdown file in the configured plans directory.',
    promptSnippet: 'Save the implementation plan already presented in chat to the configured plans directory',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(toolCallId, _params, signal, onUpdate, ctx) {
      const generation = sessionGeneration;
      assertRuntimeActive(generation);
      if (!enabled) {
        return {
          content: [{ type: 'text', text: 'Plan mode is disabled. Use normal file tools instead.' }],
          details: { written: false },
        };
      }
      const content = visiblePlanForToolCall(ctx.sessionManager.getBranch(), toolCallId);
      if (!content) {
        const error = new Error(
          'Present the complete implementation plan as visible Markdown in chat before calling write_plan.',
        );
        void telemetry.recordError(PLAN_EVENT.writePlanFailed, error, { 'plan.reason': 'missing_visible_plan' });
        throw error;
      }

      const startedAt = Date.now();
      const repoRoot = getHarnessState().root ?? ctx.cwd;
      const plansDirectory = resolvePlanningPlansDirectory(
        activePlanningConfig?.plansDirectory,
        repoRoot,
        os.homedir(),
      );
      const sessionId = planSessionIdentifier(ctx.sessionManager.getSessionId());
      activePlanId ??= createPlanIdentifier();
      const storedPlanPath =
        currentPlan?.planId === activePlanId && path.dirname(currentPlan.path) === plansDirectory
          ? currentPlan.path
          : undefined;
      const title = planTitleSlug(content);
      let planId = activePlanId;
      let planPath = storedPlanPath ?? path.join(plansDirectory, `${title}--${planId}.md`);
      const timeoutController = new AbortController();
      const timeoutError = new Error(`Writing ${planPath} timed out after ${WRITE_PLAN_TIMEOUT_MS}ms.`);
      const timeout = setTimeout(() => timeoutController.abort(timeoutError), WRITE_PLAN_TIMEOUT_MS);
      const writeSignal = AbortSignal.any([
        timeoutController.signal,
        runtimeAbortController.signal,
        ...(signal ? [signal] : []),
      ]);
      let phase: PlanWritePhase = 'checking';
      const reportPhase = (): void => {
        onUpdate?.({
          content: [{ type: 'text', text: `${phase === 'checking' ? 'Checking' : 'Writing'} ${planPath}...` }],
          details: { phase, path: planPath, startedAt },
        });
      };
      const recordRefusal = (refusal: string, message: string): void => {
        void telemetry.recordWarning(PLAN_EVENT.writePlanUnsafePath, message, {
          'plan.phase': phase,
          'plan.refusal': refusal,
        });
      };

      try {
        reportPhase();
        try {
          await waitForAbortable(
            () => fs.promises.mkdir(plansDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
            writeSignal,
          );
        } catch (error) {
          if (writeSignal.aborted) throw abortReason(writeSignal);
          throw new Error(`Could not create the configured plans directory ${plansDirectory}.`, { cause: error });
        }
        const directoryStats = await waitForAbortable(() => fs.promises.lstat(plansDirectory), writeSignal);
        const resolvedPlansDirectory = await waitForAbortable(() => fs.promises.realpath(plansDirectory), writeSignal);
        if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
          recordRefusal('unsafe_plans_directory', 'Refused to write the plan because the configured path is unsafe.');
          return {
            content: [{ type: 'text', text: 'Refused to write the plan because the configured path is unsafe.' }],
            details: { written: false, path: planPath, phase, durationMs: Date.now() - startedAt },
          };
        }

        assertRuntimeActive(generation);
        phase = 'writing';
        reportPhase();
        let planFile: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
        try {
          for (let attempt = 0; attempt < PLAN_ALLOCATION_ATTEMPTS; attempt += 1) {
            try {
              const createFlags = storedPlanPath ? 0 : fs.constants.O_EXCL;
              planFile = await waitForAbortable(
                () =>
                  fs.promises.open(
                    planPath,
                    fs.constants.O_CREAT |
                      fs.constants.O_WRONLY |
                      fs.constants.O_NONBLOCK |
                      fs.constants.O_NOFOLLOW |
                      createFlags,
                    PRIVATE_FILE_MODE,
                  ),
                writeSignal,
              );
              break;
            } catch (error) {
              const collision =
                !storedPlanPath && error instanceof Error && 'code' in error && String(error.code) === 'EEXIST';
              if (!collision || attempt === PLAN_ALLOCATION_ATTEMPTS - 1) throw error;
              planId = createPlanIdentifier();
              activePlanId = planId;
              planPath = path.join(plansDirectory, `${title}--${planId}.md`);
              persistState();
            }
          }
          if (!planFile) throw new Error(`Could not allocate a unique plan filename in ${plansDirectory}.`);
          const resolvedAfterOpen = await waitForAbortable(() => fs.promises.realpath(plansDirectory), writeSignal);
          const stats = await waitForAbortable(() => planFile!.stat(), writeSignal);
          if (resolvedAfterOpen !== resolvedPlansDirectory || !stats.isFile() || stats.nlink !== 1) {
            recordRefusal('invalid_destination', INVALID_PLAN_DESTINATION);
            return {
              content: [{ type: 'text', text: INVALID_PLAN_DESTINATION }],
              details: { written: false, path: planPath, phase, durationMs: Date.now() - startedAt },
            };
          }
          await waitForAbortable(() => planFile!.truncate(0), writeSignal);
          await waitForAbortable(
            () => planFile!.writeFile(content, { encoding: 'utf8', signal: writeSignal }),
            writeSignal,
          );
        } catch (error) {
          if (error instanceof Error && 'code' in error && ['EISDIR', 'ELOOP', 'ENXIO'].includes(String(error.code))) {
            recordRefusal('invalid_destination', INVALID_PLAN_DESTINATION);
            return {
              content: [{ type: 'text', text: INVALID_PLAN_DESTINATION }],
              details: { written: false, path: planPath, phase, durationMs: Date.now() - startedAt },
            };
          }
          throw error;
        } finally {
          await planFile?.close();
        }
        assertRuntimeActive(generation);
        currentPlan = { content, path: planPath, sessionId, planId, title, writtenAt: new Date().toISOString() };
        pi.appendEntry(PLAN_DOCUMENT_ENTRY, currentPlan);
        planReadyForReview = true;
        awaitingVoicePlanDecision = false;
        void telemetry.recordEvent(PLAN_EVENT.planWritten, {
          'plan.written': true,
          'plan.bytes': Buffer.byteLength(content, 'utf8'),
          'plan.duration_ms': Date.now() - startedAt,
          'plan.revised': Boolean(storedPlanPath),
        });
        return {
          content: [{ type: 'text', text: `Wrote implementation plan to ${planPath}.` }],
          details: { written: true, path: planPath, phase, durationMs: Date.now() - startedAt },
        };
      } catch (error) {
        if (!active || generation !== sessionGeneration) throw abortReason(runtimeAbortController.signal);
        const attributes = {
          'plan.phase': phase,
          'plan.duration_ms': Date.now() - startedAt,
        };
        if (timeoutController.signal.aborted && !signal?.aborted) {
          const timedOut = new Error(`write_plan timed out during ${phase} for ${planPath}.`, { cause: error });
          void telemetry.recordError(PLAN_EVENT.writePlanTimedOut, timedOut, {
            ...attributes,
            'plan.timeout_ms': WRITE_PLAN_TIMEOUT_MS,
          });
          throw timedOut;
        }
        void telemetry.recordError(PLAN_EVENT.writePlanFailed, error, {
          ...attributes,
          'plan.cancelled': signal?.aborted ?? false,
        });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  });

  async function applyPlanReviewDecision(
    decision: typeof EXIT_PLAN_DECISION | typeof CONTINUE_PLAN_DECISION,
    ctx: ExtensionContext,
  ) {
    assertRuntimeActive();
    void telemetry.recordEvent(PLAN_EVENT.planReviewCompleted, {
      'plan.outcome': decision === EXIT_PLAN_DECISION ? 'exited' : 'continued',
    });
    if (decision === EXIT_PLAN_DECISION) {
      const exited = await queueTransition(() => exitPlanMode(ctx, PLAN_MODE_TRIGGER_PLAN_APPROVED));
      return {
        content: [
          {
            type: 'text' as const,
            text: exited
              ? 'The user approved exiting plan mode. Full tool access is restored. Begin implementing the approved plan.'
              : 'The previous model could not be restored. Plan mode remains read-only.',
          },
        ],
        details: { exited },
      };
    }

    planReadyForReview = false;
    return {
      content: [
        { type: 'text' as const, text: 'The user chose to continue planning. Remain read-only and refine the plan.' },
      ],
      details: { exited: false },
    };
  }

  pi.registerTool({
    name: COMPLETE_PLAN_TOOL,
    label: 'Complete Plan',
    description:
      'Present the saved implementation plan for exit-or-continue approval. Interactive sessions use the normal selector; autonomous voice narrates a plain-text handoff and waits for the next user message.',
    promptSnippet: 'Request explicit exit-or-continue approval after the saved plan has been presented',
    promptGuidelines: [
      'After write_plan succeeds, call complete_plan without a decision so it can present the review question.',
      'When autonomous voice returns an awaiting-response result, stop. Interpret the next ordinary user message, then call complete_plan again with decision "exit" or "continue".',
      `Never pass decision "${EXIT_PLAN_DECISION}" without the user explicitly choosing "${EXIT_PLAN_MODE_CHOICE}".`,
    ],
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: [EXIT_PLAN_DECISION, CONTINUE_PLAN_DECISION] },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const generation = sessionGeneration;
      assertRuntimeActive(generation);
      if (!enabled) {
        return {
          content: [{ type: 'text', text: 'Plan mode is already disabled.' }],
          details: { exited: false },
        };
      }
      if (!planReadyForReview) {
        return {
          content: [
            {
              type: 'text',
              text: 'Present the complete plan in chat and save it with write_plan before requesting approval.',
            },
          ],
          details: { exited: false },
        };
      }
      if (!ctx.hasUI) {
        void telemetry.recordEvent(PLAN_EVENT.planReviewCompleted, { 'plan.outcome': 'no_ui' });
        return {
          content: [
            {
              type: 'text',
              text: 'The plan is complete, but this run cannot ask the user interactively. Remain in plan mode until the user uses SPC p e.',
            },
          ],
          details: { exited: false },
        };
      }

      const decision = isRecord(params) ? params.decision : undefined;
      const hasDecision = decision === EXIT_PLAN_DECISION || decision === CONTINUE_PLAN_DECISION;
      if (awaitingVoicePlanDecision) {
        if (!hasDecision) {
          throw new Error('The narrated plan review is waiting for an explicit exit or continue decision.');
        }
        awaitingVoicePlanDecision = false;
        return applyPlanReviewDecision(decision, ctx);
      }
      if (decision !== undefined) {
        throw new Error('Call complete_plan without a decision before submitting a narrated plan-review answer.');
      }

      if (await requestVoicePlanReview()) {
        assertRuntimeActive(generation);
        awaitingVoicePlanDecision = true;
        return voicePlanReviewResult();
      }

      const choice = await ctx.ui.select('Plan complete. What would you like to do?', [
        EXIT_PLAN_MODE_CHOICE,
        CONTINUE_PLANNING_CHOICE,
      ]);
      assertRuntimeActive(generation);
      return applyPlanReviewDecision(
        choice === EXIT_PLAN_MODE_CHOICE ? EXIT_PLAN_DECISION : CONTINUE_PLAN_DECISION,
        ctx,
      );
    },
  });

  if (doomIntegrations) {
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const dispose = requireDoomUiHub(uiContext).registerLeaderActions<ExtensionContext>({
        source: PLAN_LEADER_SOURCE,
        handlers: {
          'plan.normal': () => {
            const ctx = active ? activeContext : undefined;
            return ctx
              ? queueTransition(() => activateFlavor(ctx, 'normal', PLAN_MODE_TRIGGER_LEADER, false))
              : undefined;
          },
          'plan.exit': () => {
            const ctx = active ? activeContext : undefined;
            return ctx
              ? queueTransition(async () => {
                  await exitPlanMode(ctx, PLAN_MODE_TRIGGER_LEADER);
                })
              : undefined;
          },
          'plan.debug': () => {
            const ctx = active ? activeContext : undefined;
            return ctx
              ? queueTransition(() => activateFlavor(ctx, 'debug', PLAN_MODE_TRIGGER_LEADER, false))
              : undefined;
          },
          'plan.fable': () => {
            const ctx = active ? activeContext : undefined;
            return ctx
              ? queueTransition(() => activateFlavor(ctx, 'fable', PLAN_MODE_TRIGGER_LEADER, false))
              : undefined;
          },
        },
        onError: (error, actionName) => {
          if (!active) return;
          if (activeContext?.hasUI) {
            activeContext.ui.notify(`Leader action ${actionName} failed. Plan mode remains read-only.`, WARNING_STYLE);
          }
          void telemetry.recordError(PLAN_EVENT.modeEnabled, error, {
            [PLAN_TRIGGER_ATTRIBUTE]: PLAN_MODE_TRIGGER_LEADER,
            'plan.action': actionName,
          });
        },
      });
      disposeLeaderActions = dispose;
      return () => {
        dispose();
        if (disposeLeaderActions === dispose) disposeLeaderActions = undefined;
      };
    });
  }

  pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
    if (!active || !enabled) return undefined;
    const isFlavorTool =
      (activeFlavor === 'debug' &&
        (event.toolName === RECORD_DEBUG_EVIDENCE_TOOL || diagnosticTools.has(event.toolName))) ||
      (activeFlavor === 'fable' && event.toolName === RUN_FABLE_PLAN_TOOL);
    if (!PLAN_MODE_PARENT_TOOLS.has(event.toolName) && !isFlavorTool) {
      return { block: true, reason: `Plan mode blocks the ${event.toolName} tool. Use SPC p e to restore access.` };
    }
    const model = planningSubagentModel(activePlanningConfig?.subagents, ctx.model);
    if (event.toolName === TASK_TOOL) {
      if (model) configurePlanningTaskInput(event.input as MutableTaskInput, model);
      return undefined;
    }
    if (event.toolName !== SUBAGENT_TOOL) return undefined;

    const input = event.input as MutableSubagentInput;
    if (isBlockedSubagentManagementAction(input.action)) {
      return {
        block: true,
        reason: `Plan mode blocks subagent management action '${input.action}'. Use SPC p e first.`,
      };
    }
    constrainSubagentInput(input);
    if (model) configurePlanningSubagentInput(input, model);
    return undefined;
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!active) return undefined;
    const sections: string[] = [];
    if (enabled) {
      const repoRoot = getHarnessState().root ?? ctx.cwd;
      const plansDirectory = resolvePlanningPlansDirectory(
        activePlanningConfig?.plansDirectory,
        repoRoot,
        os.homedir(),
      );
      sections.push(
        `[PLAN MODE ACTIVE]\nYou are in repository read-only plan mode. The dedicated write_plan tool may write one unique Markdown plan file under ${plansDirectory}.\n\nExplore the codebase and produce a concrete implementation plan. For every plan, first call subagent with action "agents", cluster the exploration by independent domain, subsystem, or integration boundary, and create a provisional task graph with the task tool. Select specialized agents by matching their names and descriptions to each cluster. Assign every unblocked delegated task through the task tool, and use a one-shot inlineAgent with a focused systemPrompt when no discovered specialist fits. Treat the initial graph as provisional, not as a fixed contract. After findings arrive, review the entire graph at least once and perform one to three review passes in total. In each pass, use the evidence to add, rewrite, delete, cancel, reassign, or change blockedBy relationships for tasks when warranted. Do not keep following tasks that new information has made stale. Stop revising early when the graph is stable, or after the third pass.\n\nEvery plan must end with a delegated planning-draft stage blocked by all exploration and decision tasks. A single-boundary plan gets one planning draft. A complex plan spanning multiple subsystems, domains, packages, apps, or integration boundaries gets two planning drafts concurrently. Use three concurrent drafts instead when the work is cross-layer, migration-sensitive, security-sensitive, or similarly high risk. Assign each draft through the task tool to the discovered "planner" agent with context "fork" so it receives the conversation and gathered evidence. If the planner agent is unavailable, assign the same draft task through the task tool with a focused inlineAgent. All children receive read, Bash, grep, find, ls, and configured MCP tools with artifacts disabled. Bash and MCP tools are for read-only inspection and must not modify files, external systems, or repository state. Doom Team runs asynchronously, so do not poll. After launch, continue non-overlapping exploration or end your turn; completion notifications wake the parent session.\n\nAfter all planning drafts complete, the main agent must compare the candidates, pick the strongest draft, cross-check it against the gathered evidence and the other drafts, resolve conflicts and gaps, and ask the user only for product decisions. A child produces the draft, but the main agent owns and synthesizes the final plan. Do not modify files or repository state except through write_plan. Start the final plan with a meaningful Markdown H1 because write_plan derives the filename from it. Present the complete plan as visible Markdown in chat, then call write_plan with no arguments. After write_plan succeeds, clear the completed durable task graph and call complete_plan without a decision. In an interactive text session, complete_plan uses the normal exit-or-continue selector. Under autonomous voice, it displays and narrates the choices without opening a blocking dialog, then ends the turn. Interpret the user's next ordinary message and call complete_plan again with decision "exit" or "continue". Do not exit plan mode without explicit approval.`,
        buildFlavorPlanningPrompt(activeFlavor!, plansDirectory, debugEvidence, fableStage),
      );
    }
    if (currentPlan) {
      sections.push(`[CURRENT PLAN]\nSource: ${currentPlan.path}\n\n${currentPlan.content}`);
    }
    if (sections.length === 0) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${sections.join('\n\n')}` };
  });

  pi.on('context', async (event) => {
    if (!active) return undefined;
    return {
      messages: event.messages.filter((message) => {
        const custom = message as { customType?: string };
        return custom.customType !== PLAN_MODE_CONTEXT;
      }),
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    if (!active) return;
    configSessionCtx = ctx;
    const generation = ++sessionGeneration;
    const entries = ctx.sessionManager.getEntries();
    const state = entries
      .flatMap((entry) =>
        entry.type === 'custom' && entry.customType === PLAN_MODE_ENTRY ? [parsePersistedPlanState(entry.data)] : [],
      )
      .filter((value): value is PersistedPlanModeState => value !== undefined)
      .at(-1);
    const piSessionId = ctx.sessionManager.getSessionId();
    const sessionId = planSessionIdentifier(piSessionId);
    const storedPlan = entries
      .flatMap((entry) =>
        entry.type === 'custom' && entry.customType === PLAN_DOCUMENT_ENTRY ? [parsePlanDocument(entry.data)] : [],
      )
      .filter((value): value is PlanDocument => value !== undefined)
      .at(-1);

    const snapshotFromPreviousSession = planSnapshot;
    capabilityCeiling?.dispose();
    capabilityCeiling = undefined;
    currentPlan = storedPlan?.sessionId === sessionId ? storedPlan : undefined;
    activePlanId = state?.planId ?? currentPlan?.planId;
    planReadyForReview = false;
    awaitingVoicePlanDecision = false;
    activePlanningConfig = undefined;
    debugEvidence = undefined;
    enabled = false;
    activeFlavor = undefined;
    // A session that restores nothing never reaches updateStatus, and the menu
    // would otherwise still offer the exit the previous session left on it.
    updateLeader();
    planSnapshot = state?.originalSnapshot;
    interruptedFableStage = state?.interruptedFableStage;
    fableStage = interruptedFableStage ? 'interrupted' : 'idle';
    activeContext = ctx;
    if (state?.activeFlavor) {
      await activateFlavor(ctx, state.activeFlavor, PLAN_MODE_TRIGGER_SESSION_RESTORE, true);
      assertRuntimeActive(generation);
    } else {
      const snapshotToRestore = state?.originalSnapshot ?? snapshotFromPreviousSession;
      if (snapshotToRestore) {
        const restored = await restoreMainAgent(ctx, snapshotToRestore);
        assertRuntimeActive(generation);
        if (restored) {
          pi.setActiveTools(
            restoreSnapshotTools(
              snapshotToRestore.tools,
              pi.getActiveTools(),
              pi.getAllTools().map((tool) => tool.name),
            ),
          );
        }
      } else {
        pi.setActiveTools(
          pi
            .getActiveTools()
            .filter(
              (name) =>
                name !== COMPLETE_PLAN_TOOL &&
                name !== WRITE_PLAN_TOOL &&
                name !== RECORD_DEBUG_EVIDENCE_TOOL &&
                name !== RUN_FABLE_PLAN_TOOL,
            ),
        );
      }
      assertRuntimeActive(generation);
      planSnapshot = undefined;
      updateStatus(ctx);
    }
  });
}
