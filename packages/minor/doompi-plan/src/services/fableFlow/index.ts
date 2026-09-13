import { Buffer } from 'node:buffer';

export const FABLE_PROVIDER_SOURCE = '@agimon-ai/doompi-team';
export const FABLE_PLAN_REQUESTER = '@agimon-ai/doompi-plan';
export const FABLE_PLAN_RUNTIME = 'claude';
export const FABLE_PLAN_MODEL = 'fable';
export const FABLE_PLAN_PROFILE = 'claude/fable-plan-v1';
export const MAX_FABLE_PACKET_BYTES = 32 * 1024;
export const MAX_FABLE_TEXT_BYTES = 4 * 1024;
export const MAX_FABLE_ARRAY_ITEMS = 24;

const SECRET_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key|authorization|bearer)\s*[:=]/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/u,
];
const CONTROL_CHARACTER_MAX = 31;
const DELETE_CHARACTER = 127;
const MAX_SOURCE_PATH_LENGTH = 512;

export interface FablePlanFinding {
  path: string;
  finding: string;
}

export interface FablePlanPacket {
  goal: string[];
  constraints: string[];
  decisions: string[];
  verifiedFindings: FablePlanFinding[];
  inferredFindings: string[];
  unresolvedQuestions: string[];
  currentPlan?: string;
}

export type FablePlanStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';
export type FablePlanStage = 'draft' | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface FablePlanResult {
  operationId: string;
  status: FablePlanStatus;
  stage: FablePlanStage;
  draft?: string;
  review?: string;
  draftRunId?: string;
  reviewRunId?: string;
  durationMs: number;
  errorCode?: string;
}

export interface FablePlanRequest {
  requester: typeof FABLE_PLAN_REQUESTER;
  operationId: string;
  runtime: typeof FABLE_PLAN_RUNTIME;
  model: typeof FABLE_PLAN_MODEL;
  profile: typeof FABLE_PLAN_PROFILE;
  packet: FablePlanPacket;
}

export interface FablePlanBroker {
  start(request: FablePlanRequest, signal: AbortSignal): Promise<FablePlanResult>;
  cancel(operationId: string, reason: string): void;
}

export interface FableFlowOptions {
  broker?: FablePlanBroker;
  isAuthorized: () => boolean;
  /** Supplies operation ids. Injected so a test can pin them. */
  newOperationId?: () => string;
  timeoutMs?: number;
  onStage?: (stage: FableStage) => void;
  onError?: (error: unknown) => void;
}

export type FableStage = 'idle' | 'draft' | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface FablePlanFlow {
  run(value: unknown, signal?: AbortSignal): Promise<FablePlanResult>;
  cancel(reason?: string): void;
  isActive(): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= CONTROL_CHARACTER_MAX || code === DELETE_CHARACTER)) return true;
  }
  return false;
}

export function containsSuspectedCredential(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function boundedText(value: unknown, field: string, required = true): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const text = value.trim();
  if (!text && required) throw new Error(`${field} must not be empty.`);
  if (Buffer.byteLength(text, 'utf8') > MAX_FABLE_TEXT_BYTES || hasControlCharacter(text)) {
    throw new Error(`${field} exceeds the bounded Fable text limit or contains control characters.`);
  }
  if (containsSuspectedCredential(text)) throw new Error(`${field} appears to contain a credential.`);
  return text;
}

function boundedList(value: unknown, field: string, required = true): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > MAX_FABLE_ARRAY_ITEMS) throw new Error(`${field} exceeds the bounded item limit.`);
  const items = value.map((item, index) => boundedText(item, `${field}[${index}]`));
  if (required && items.length === 0) throw new Error(`${field} must contain at least one item.`);
  return items;
}

function boundedPath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const sourcePath = value.trim();
  if (!sourcePath || sourcePath.length > MAX_SOURCE_PATH_LENGTH || hasControlCharacter(sourcePath)) {
    throw new Error(`${field} is not a safe source path.`);
  }
  if (containsSuspectedCredential(sourcePath)) throw new Error(`${field} appears to contain a credential.`);
  return sourcePath;
}

function boundedFindings(value: unknown): FablePlanFinding[] {
  if (!Array.isArray(value)) throw new Error('verifiedFindings must be an array.');
  if (value.length > MAX_FABLE_ARRAY_ITEMS) throw new Error('verifiedFindings exceeds the bounded item limit.');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`verifiedFindings[${index}] must be an object.`);
    const keys = Object.keys(item);
    if (keys.some((key) => key !== 'path' && key !== 'finding')) {
      throw new Error(`verifiedFindings[${index}] contains an unsupported field.`);
    }
    return {
      path: boundedPath(item.path, `verifiedFindings[${index}].path`),
      finding: boundedText(item.finding, `verifiedFindings[${index}].finding`),
    };
  });
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${field} contains unsupported field '${unexpected}'.`);
}

export function sanitizeFablePacket(value: unknown): FablePlanPacket {
  if (!isRecord(value)) throw new Error('Fable packet must be an object.');
  assertAllowedKeys(
    value,
    ['goal', 'constraints', 'decisions', 'verifiedFindings', 'inferredFindings', 'unresolvedQuestions', 'currentPlan'],
    'Fable packet',
  );
  const packet: FablePlanPacket = {
    goal: boundedList(value.goal, 'goal'),
    constraints: boundedList(value.constraints, 'constraints', false),
    decisions: boundedList(value.decisions, 'decisions', false),
    verifiedFindings: boundedFindings(value.verifiedFindings),
    inferredFindings: boundedList(value.inferredFindings, 'inferredFindings', false),
    unresolvedQuestions: boundedList(value.unresolvedQuestions, 'unresolvedQuestions', false),
    ...(value.currentPlan === undefined ? {} : { currentPlan: boundedText(value.currentPlan, 'currentPlan', false) }),
  };
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > MAX_FABLE_PACKET_BYTES) {
    throw new Error('Fable packet exceeds the bounded packet size.');
  }
  return packet;
}

function safeResult(result: FablePlanResult): FablePlanResult {
  const output = [result.draft, result.review].filter((value): value is string => value !== undefined).join('\n');
  if (containsSuspectedCredential(output)) {
    return {
      operationId: result.operationId,
      status: 'failed',
      stage: 'failed',
      durationMs: result.durationMs,
      errorCode: 'unsafe_output',
    };
  }
  return result;
}

function timedOutResult(operationId: string, startedAt: number): FablePlanResult {
  return {
    operationId,
    status: 'timed_out',
    stage: 'interrupted',
    durationMs: Math.max(0, Date.now() - startedAt),
    errorCode: 'timeout',
  };
}

export function createFablePlanFlow(options: FableFlowOptions): FablePlanFlow {
  const newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
  let active:
    | {
        operationId: string;
        controller: AbortController;
        cancelSent: boolean;
      }
    | undefined;

  const cancel = (reason = 'Fable operation cancelled.'): void => {
    const current = active;
    if (!current) return;
    if (!current.cancelSent) {
      current.cancelSent = true;
      try {
        options.broker?.cancel(current.operationId, reason);
      } catch (error) {
        options.onError?.(error);
      }
    }
    current.controller.abort(new Error(reason));
  };

  const run = async (value: unknown, signal?: AbortSignal): Promise<FablePlanResult> => {
    if (active) throw new Error('A Fable operation is already active for this session.');
    if (!options.isAuthorized()) throw new Error('The Fable capability profile is not authorized.');
    const packet = sanitizeFablePacket(value);
    const operationId = `fable-${newOperationId()}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    active = { operationId, controller, cancelSent: false };
    options.onStage?.('draft');

    const parentAbort = (): void => controller.abort(signal?.reason);
    if (signal) {
      signal.addEventListener('abort', parentAbort, { once: true });
      if (signal.aborted) parentAbort();
    }

    const brokerRequest: FablePlanRequest = {
      requester: FABLE_PLAN_REQUESTER,
      operationId,
      runtime: FABLE_PLAN_RUNTIME,
      model: FABLE_PLAN_MODEL,
      profile: FABLE_PLAN_PROFILE,
      packet,
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutTriggered = false;
    try {
      if (!options.broker) return timedOutResult(operationId, startedAt);
      const brokerResult = options.broker.start(brokerRequest, controller.signal);
      const cancelledResult = new Promise<FablePlanResult>((resolve) => {
        const onAbort = (): void => {
          if (timeoutTriggered) return;
          resolve({
            operationId,
            status: 'cancelled',
            stage: 'cancelled',
            durationMs: Math.max(0, Date.now() - startedAt),
            errorCode: 'cancelled',
          });
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const timeoutResult =
        options.timeoutMs === undefined
          ? undefined
          : new Promise<FablePlanResult>((resolve) => {
              timeout = setTimeout(() => {
                timeoutTriggered = true;
                cancel('Fable operation timed out.');
                resolve(timedOutResult(operationId, startedAt));
              }, options.timeoutMs);
            });
      const result =
        timeoutResult === undefined
          ? await Promise.race([brokerResult, cancelledResult])
          : await Promise.race([brokerResult, timeoutResult, cancelledResult]);
      const safe = safeResult(result);
      options.onStage?.(
        safe.status === 'completed' ? 'completed' : safe.status === 'cancelled' ? 'cancelled' : safe.stage,
      );
      return safe;
    } catch (error) {
      options.onError?.(error);
      const failure: FablePlanResult = {
        operationId,
        status: 'failed',
        stage: 'failed',
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode: 'unavailable',
      };
      options.onStage?.('failed');
      return failure;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', parentAbort);
      active = undefined;
    }
  };

  return {
    run,
    cancel,
    isActive: () => active !== undefined,
  };
}
