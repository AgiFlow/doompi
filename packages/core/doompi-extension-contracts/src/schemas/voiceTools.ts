import type { Context } from '@deepseek-ai/cordis';
import { type Static, type TSchema, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Voice-owned Cordis service for the live tool registrar and active session. */
export const DOOM_VOICE_TOOLS_SERVICE = 'doom/voice-tools';

/** The two stable Pi tools that expose registered voice capabilities. */
export const VOICE_DESCRIBE_TOOL_NAME = 'describe_voice_tools' as const;
export const VOICE_USE_TOOL_NAME = 'use_voice_tools' as const;
export const VOICE_FACADE_TOOL_NAMES = [VOICE_DESCRIBE_TOOL_NAME, VOICE_USE_TOOL_NAME] as const;
/** The standalone Pi tool owned by an active autonomous Voice session. */
export const VOICE_NARRATE_TOOL_NAME = 'narrate' as const;
/** Every Pi tool whose availability is owned by autonomous Voice mode. */
export const VOICE_MODE_TOOL_NAMES = [...VOICE_FACADE_TOOL_NAMES, VOICE_NARRATE_TOOL_NAME] as const;
export const VOICE_TOOL_DEFAULT_TIMEOUT_MS = 10_000;
export const VOICE_TOOL_MAX_TIMEOUT_MS = 30_000;
export const VOICE_TOOL_MAX_BATCH_ITEMS = 16;
export const VOICE_TOOL_MAX_INPUT_BYTES = 64 * 1024;
export const VOICE_TOOL_MAX_BATCH_BYTES = 256 * 1024;
export const VOICE_TOOL_MAX_SCHEMA_BYTES = 32 * 1024;
export const VOICE_TOOL_MAX_JSON_DEPTH = 16;
export const VOICE_TOOL_TERMINAL_OPERATION_LIMIT = 256;
export const VOICE_TOOL_MAX_IDENTIFIER_LENGTH = 128;
export const VOICE_TOOL_MAX_LABEL_LENGTH = 96;
export const VOICE_TOOL_MAX_DESCRIPTION_LENGTH = 240;
export const VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH = 240;
export const VOICE_TOOL_MAX_DOMAIN_COUNT = 32;

const SAFE_IDENTIFIER = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/u;
const SAFE_NAME = /^[a-z][a-z0-9_:-]*$/u;
const MAX_ORDER = 1_000;

export const VOICE_TOOL_ERROR_CODE = {
  hostUnavailable: 'VOICE_TOOL_HOST_UNAVAILABLE',
  inactive: 'VOICE_TOOL_INACTIVE',
  staleSession: 'VOICE_TOOL_STALE_SESSION',
  staleCatalog: 'VOICE_TOOL_STALE_CATALOG',
  notFound: 'VOICE_TOOL_NOT_FOUND',
  nameConflict: 'VOICE_TOOL_NAME_CONFLICT',
  invalidInput: 'VOICE_TOOL_INVALID_INPUT',
  invalidResult: 'VOICE_TOOL_INVALID_RESULT',
  executionFailed: 'VOICE_TOOL_EXECUTION_FAILED',
  timeout: 'VOICE_TOOL_TIMEOUT',
  aborted: 'VOICE_TOOL_ABORTED',
  cancelled: 'VOICE_TOOL_CANCELLED',
  registrationDisposed: 'VOICE_TOOL_REGISTRATION_DISPOSED',
  sessionShutdown: 'VOICE_TOOL_SESSION_SHUTDOWN',
  batchStopped: 'VOICE_TOOL_BATCH_STOPPED',
  reloadQueued: 'VOICE_TOOL_RELOAD_QUEUED',
  invalidRequest: 'VOICE_TOOL_INVALID_REQUEST',
} as const;

export const VOICE_TOOL_HOST_UNAVAILABLE = VOICE_TOOL_ERROR_CODE.hostUnavailable;
export const VOICE_TOOL_INACTIVE = VOICE_TOOL_ERROR_CODE.inactive;
export const VOICE_TOOL_STALE_SESSION = VOICE_TOOL_ERROR_CODE.staleSession;
export const VOICE_TOOL_STALE_CATALOG = VOICE_TOOL_ERROR_CODE.staleCatalog;
export const VOICE_TOOL_NOT_FOUND = VOICE_TOOL_ERROR_CODE.notFound;
export const VOICE_TOOL_NAME_CONFLICT = VOICE_TOOL_ERROR_CODE.nameConflict;
export const VOICE_TOOL_INVALID_INPUT = VOICE_TOOL_ERROR_CODE.invalidInput;
export const VOICE_TOOL_INVALID_RESULT = VOICE_TOOL_ERROR_CODE.invalidResult;
export const VOICE_TOOL_TIMEOUT = VOICE_TOOL_ERROR_CODE.timeout;
export const VOICE_TOOL_ABORTED = VOICE_TOOL_ERROR_CODE.aborted;
export const VOICE_TOOL_EXECUTION_FAILED = VOICE_TOOL_ERROR_CODE.executionFailed;
export const VOICE_TOOL_BATCH_STOPPED = VOICE_TOOL_ERROR_CODE.batchStopped;

export const VoiceToolDescriptorSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_IDENTIFIER.source }),
    id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_IDENTIFIER.source }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_NAME.source }),
    label: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_LABEL_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_DESCRIPTION_LENGTH }),
    order: Type.Integer({ minimum: 0, maximum: MAX_ORDER }),
    inputSchema: Type.Unknown(),
    resultSchema: Type.Unknown(),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: VOICE_TOOL_MAX_TIMEOUT_MS })),
  },
  { additionalProperties: false },
);
export interface VoiceToolDescriptor {
  readonly source: string;
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly order: number;
  readonly inputSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly timeoutMs?: number;
}

export const VoiceToolBatchCallSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
      pattern: SAFE_NAME.source,
      description: 'Capability name exactly as describe_voice_tools reported it.',
    }),
    input: Type.Unknown({
      description:
        'Arguments for this capability, shaped by the input_schema that describe_voice_tools returns when called with names. Pass an empty object for a capability that takes none.',
    }),
  },
  { additionalProperties: false },
);
export type VoiceToolBatchCall = Static<typeof VoiceToolBatchCallSchema>;

export const VoiceToolDescribeInputSchema = Type.Object(
  {
    names: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_NAME.source }),
        {
          maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
          description:
            'Capabilities to describe in full, including their input schemas. Omit to list every registered capability by name and description only.',
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export type VoiceToolDescribeInput = Static<typeof VoiceToolDescribeInputSchema>;

export const VoiceToolCatalogTokenSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  description:
    'Opaque catalog token from the most recent describe_voice_tools result, copied verbatim. It is invalidated whenever a capability registers or deregisters and whenever autonomous voice is activated or deactivated.',
});
export type VoiceToolCatalogToken = Static<typeof VoiceToolCatalogTokenSchema>;

export const VoiceToolUseInputSchema = Type.Object(
  {
    catalogToken: VoiceToolCatalogTokenSchema,
    calls: Type.Array(VoiceToolBatchCallSchema, {
      minItems: 1,
      maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
      description:
        'Capability calls to run in this order. All of them are validated before any of them run, so a single invalid call rejects the whole batch.',
    }),
  },
  { additionalProperties: false },
);
export type VoiceToolUseInput = Static<typeof VoiceToolUseInputSchema>;

export const VoiceToolErrorCodeSchema = Type.Union([
  Type.Literal('VOICE_TOOL_HOST_UNAVAILABLE'),
  Type.Literal('VOICE_TOOL_INACTIVE'),
  Type.Literal('VOICE_TOOL_STALE_SESSION'),
  Type.Literal('VOICE_TOOL_STALE_CATALOG'),
  Type.Literal('VOICE_TOOL_NOT_FOUND'),
  Type.Literal('VOICE_TOOL_NAME_CONFLICT'),
  Type.Literal('VOICE_TOOL_INVALID_INPUT'),
  Type.Literal('VOICE_TOOL_INVALID_RESULT'),
  Type.Literal('VOICE_TOOL_EXECUTION_FAILED'),
  Type.Literal('VOICE_TOOL_TIMEOUT'),
  Type.Literal('VOICE_TOOL_ABORTED'),
  Type.Literal('VOICE_TOOL_CANCELLED'),
  Type.Literal('VOICE_TOOL_REGISTRATION_DISPOSED'),
  Type.Literal('VOICE_TOOL_SESSION_SHUTDOWN'),
  Type.Literal('VOICE_TOOL_BATCH_STOPPED'),
  Type.Literal('VOICE_TOOL_RELOAD_QUEUED'),
  Type.Literal('VOICE_TOOL_INVALID_REQUEST'),
]);
export type VoiceToolErrorCode = Static<typeof VoiceToolErrorCodeSchema>;

export const VoiceToolErrorSchema = Type.Object(
  {
    code: VoiceToolErrorCodeSchema,
    message: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH }),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type VoiceToolErrorPayload = Static<typeof VoiceToolErrorSchema>;

export const VoiceToolConflictDiagnosticSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    message: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH }),
    claims: Type.Array(
      Type.Object(
        {
          source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
          id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: VOICE_TOOL_MAX_BATCH_ITEMS },
    ),
  },
  { additionalProperties: false },
);
export type VoiceToolConflictDiagnostic = Static<typeof VoiceToolConflictDiagnosticSchema>;

export const VoiceToolCatalogEntrySchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    id: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_LABEL_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_DESCRIPTION_LENGTH }),
    order: Type.Integer({ minimum: 0, maximum: MAX_ORDER }),
    inputSchema: Type.Unknown(),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type VoiceToolCatalogEntry = Static<typeof VoiceToolCatalogEntrySchema>;

export const VoiceToolCatalogSnapshotSchema = Type.Object(
  {
    hostGeneration: Type.String({ minLength: 1, maxLength: 256 }),
    catalogRevision: Type.Integer({ minimum: 0 }),
    catalogToken: VoiceToolCatalogTokenSchema,
    tools: Type.Array(VoiceToolCatalogEntrySchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS * 8 }),
    conflicts: Type.Array(VoiceToolConflictDiagnosticSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS * 8 }),
    unknownNames: Type.Array(Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }), {
      maxItems: VOICE_TOOL_MAX_BATCH_ITEMS,
    }),
  },
  { additionalProperties: false },
);
export type VoiceToolCatalogSnapshot = Static<typeof VoiceToolCatalogSnapshotSchema>;

export const VoiceToolBatchItemResultSchema = Type.Object(
  {
    index: Type.Integer({ minimum: 0, maximum: VOICE_TOOL_MAX_BATCH_ITEMS }),
    name: Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH }),
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('not_executed'),
      Type.Literal('preflight_failed'),
    ]),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(VoiceToolErrorSchema),
  },
  { additionalProperties: false },
);
export type VoiceToolBatchItemResult = Static<typeof VoiceToolBatchItemResultSchema>;

export const VoiceToolBatchResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('rejected'),
      Type.Literal('cancelled'),
      Type.Literal('stopped'),
    ]),
    catalogToken: VoiceToolCatalogTokenSchema,
    results: Type.Array(VoiceToolBatchItemResultSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS }),
    errors: Type.Optional(Type.Array(VoiceToolErrorSchema, { maxItems: VOICE_TOOL_MAX_BATCH_ITEMS })),
  },
  { additionalProperties: false },
);
export type VoiceToolBatchResult = Static<typeof VoiceToolBatchResultSchema>;

export interface VoiceToolExecutionContext<Context = unknown> {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly operationId: string;
  readonly batchIndex: number;
  readonly batchSize: number;
  readonly signal: AbortSignal;
  readonly context: Context;
}

export interface VoiceToolDefinition<Context = unknown> {
  readonly descriptor: VoiceToolDescriptor;
  execute(input: unknown, execution: VoiceToolExecutionContext<Context>): unknown;
}

export interface VoiceToolRegistrationHandle {
  readonly source: string;
  readonly id: string;
  readonly registrationGeneration: string;
  dispose(): void;
}

export interface VoiceToolSessionHandle<Context = unknown> {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly active: boolean;
  setActive(active: boolean): void;
  subscribe(listener: () => void): () => void;
  describe(input?: VoiceToolDescribeInput): VoiceToolCatalogSnapshot;
  executeBatch(
    input: VoiceToolUseInput,
    context: Context,
    options?: VoiceToolExecuteOptions,
  ): Promise<VoiceToolBatchResult>;
  useVoiceTools(
    input: VoiceToolUseInput,
    context: Context,
    options?: VoiceToolExecuteOptions,
  ): Promise<VoiceToolBatchResult>;
  dispose(): void;
}

export interface VoiceToolExecuteOptions {
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export interface VoiceToolRegistrationOptions<Context = unknown> {
  readonly sessionId?: string;
  readonly context?: Context;
}

export interface DoomVoiceToolsService<SessionContext = unknown> {
  readonly generation: string;
  register<ContributionContext = SessionContext>(
    definition: VoiceToolDefinition<ContributionContext>,
    options?: VoiceToolRegistrationOptions<ContributionContext>,
  ): VoiceToolRegistrationHandle;
  bindSession(sessionId: string, context?: SessionContext): VoiceToolSessionHandle<SessionContext>;
  readSession(sessionId: string): VoiceToolSessionHandle<SessionContext> | undefined;
  subscribeSession(
    sessionId: string,
    listener: (session: VoiceToolSessionHandle<SessionContext> | undefined) => void,
  ): () => void;
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/voice-tools': DoomVoiceToolsService;
  }
}

export class VoiceToolError extends Error {
  readonly code: VoiceToolErrorCode;
  readonly retryable: boolean;

  constructor(code: VoiceToolErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'VoiceToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

interface VoiceToolClaim<Context> {
  readonly descriptor: VoiceToolDescriptor;
  readonly execute: VoiceToolDefinition<Context>['execute'];
  readonly registrationGeneration: string;
  readonly sessionId?: string;
  readonly context?: Context;
  readonly fingerprint: string;
}

interface VoiceToolOperation {
  readonly controller: AbortController;
  readonly registrationGeneration: string;
}

interface VoiceToolSessionState<Context> {
  readonly token: symbol;
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly context: Context | undefined;
  active: boolean;
  revision: number;
  disposed: boolean;
  readonly operations: Map<string, VoiceToolOperation>;
  readonly terminal: Map<string, VoiceToolBatchResult>;
  readonly listeners: Set<() => void>;
}

interface VoiceToolRegistryRoot {
  readonly generation: string;
  readonly claims: Map<string, VoiceToolClaim<unknown>[]>;
  readonly sessions: Map<string, VoiceToolSessionState<unknown>>;
  readonly sessionHandles: Map<string, VoiceToolSessionHandle<unknown>>;
  readonly sessionListeners: Map<string, Set<(session: VoiceToolSessionHandle<unknown> | undefined) => void>>;
  sequence: number;
  disposed: boolean;
}

function normalizedText(value: string, label: string, maximum: number, pattern?: RegExp): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', `Invalid ${label}.`);
  }
  if (pattern && !pattern.test(normalized)) throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', `Invalid ${label}.`);
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function validSessionId(value: string): string {
  return normalizedText(value, 'session id', 256);
}

function validOperationId(value: string): string {
  return normalizedText(value, 'operation id', VOICE_TOOL_MAX_IDENTIFIER_LENGTH);
}

function jsonText(value: unknown, maximumDepth = VOICE_TOOL_MAX_JSON_DEPTH): string {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): string => {
    if (depth > maximumDepth) throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'JSON nesting is too deep.');
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') return JSON.stringify(candidate);
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'JSON numbers must be finite.');
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object')
      throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'JSON values must be serializable.');
    if (seen.has(candidate))
      throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'Cyclic JSON values are not supported.');
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(candidate)) {
      throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'Only JSON objects and arrays are supported.');
    }
    seen.add(candidate);
    let result: string;
    if (Array.isArray(candidate)) {
      result = `[${candidate.map((item) => visit(item, depth + 1)).join(',')}]`;
    } else {
      const entries = Object.keys(candidate)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit((candidate as Record<string, unknown>)[key], depth + 1)}`);
      result = `{${entries.join(',')}}`;
    }
    seen.delete(candidate);
    return result;
  };
  return visit(value, 0);
}

function cloneJson<T>(value: T, maximumBytes: number, message = 'JSON payload exceeds its limit.'): T {
  const text = jsonText(value);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maximumBytes) throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', message);
  return JSON.parse(text) as T;
}

function schemaClone(schema: TSchema): TSchema {
  const cloned = cloneJson(schema, VOICE_TOOL_MAX_SCHEMA_BYTES, 'Voice tool schema exceeds its limit.');
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', 'Voice tool schemas must be JSON objects.');
  }
  return cloned as TSchema;
}

function validateDescriptor(descriptor: VoiceToolDescriptor): VoiceToolDescriptor {
  if (!Check(VoiceToolDescriptorSchema, descriptor)) {
    const detail = Errors(VoiceToolDescriptorSchema, descriptor)
      .slice(0, 2)
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new VoiceToolError('VOICE_TOOL_INVALID_REQUEST', `Invalid voice tool descriptor: ${detail}`);
  }
  const inputSchema = schemaClone(descriptor.inputSchema);
  const resultSchema = schemaClone(descriptor.resultSchema);
  return cloneJson(
    {
      ...descriptor,
      source: normalizedText(descriptor.source, 'voice tool source', VOICE_TOOL_MAX_IDENTIFIER_LENGTH, SAFE_IDENTIFIER),
      id: normalizedText(descriptor.id, 'voice tool id', VOICE_TOOL_MAX_IDENTIFIER_LENGTH, SAFE_IDENTIFIER),
      name: normalizedText(descriptor.name, 'voice tool name', VOICE_TOOL_MAX_IDENTIFIER_LENGTH, SAFE_NAME),
      label: normalizedText(descriptor.label, 'voice tool label', VOICE_TOOL_MAX_LABEL_LENGTH),
      description: normalizedText(descriptor.description, 'voice tool description', VOICE_TOOL_MAX_DESCRIPTION_LENGTH),
      inputSchema,
      resultSchema,
      ...(descriptor.timeoutMs === undefined
        ? {}
        : { timeoutMs: Math.min(descriptor.timeoutMs, VOICE_TOOL_MAX_TIMEOUT_MS) }),
    },
    VOICE_TOOL_MAX_SCHEMA_BYTES * 2,
  );
}

function descriptorFingerprint(descriptor: VoiceToolDescriptor): string {
  return jsonText(descriptor, VOICE_TOOL_MAX_SCHEMA_BYTES * 2);
}

function catalogToken(session: VoiceToolSessionState<unknown>): string {
  return `${session.hostGeneration}:${session.revision}`;
}

function notify(session: VoiceToolSessionState<unknown>): void {
  for (const listener of session.listeners) listener();
}

function abortOperations(
  session: VoiceToolSessionState<unknown>,
  reason: string,
  registrationGeneration?: string,
): void {
  for (const [operationId, operation] of session.operations) {
    if (registrationGeneration !== undefined && operation.registrationGeneration !== registrationGeneration) continue;
    operation.controller.abort(reason);
    session.operations.delete(operationId);
  }
}

function abortRegistrationOperations(root: VoiceToolRegistryRoot, registrationGeneration: string): void {
  for (const session of root.sessions.values()) {
    if (!session.disposed) abortOperations(session, 'Voice tool registration was disposed.', registrationGeneration);
  }
}

function claimsForSession(root: VoiceToolRegistryRoot, sessionId: string, name?: string): VoiceToolClaim<unknown>[] {
  const source = root.claims;
  if (name) {
    return (source.get(name) ?? []).filter((claim) => claim.sessionId === undefined || claim.sessionId === sessionId);
  }
  return [...source.values()].flatMap((claims) =>
    claims.filter((claim) => claim.sessionId === undefined || claim.sessionId === sessionId),
  );
}

function activeClaim(
  root: VoiceToolRegistryRoot,
  sessionId: string,
  name: string,
): { claim?: VoiceToolClaim<unknown>; conflict?: VoiceToolConflictDiagnostic } {
  const claims = claimsForSession(root, sessionId, name);
  if (claims.length === 0) return {};
  const fingerprints = new Set(claims.map((claim) => claim.fingerprint));
  if (fingerprints.size > 1) {
    return {
      conflict: {
        name,
        message: `Voice tool '${name}' has conflicting registrations.`,
        claims: claims
          .slice(0, VOICE_TOOL_MAX_BATCH_ITEMS)
          .map((claim) => ({ source: claim.descriptor.source, id: claim.descriptor.id })),
      },
    };
  }
  return { claim: claims[0] };
}

function catalog(
  root: VoiceToolRegistryRoot,
  session: VoiceToolSessionState<unknown>,
  names?: readonly string[],
): VoiceToolCatalogSnapshot {
  const grouped = new Map<string, VoiceToolClaim<unknown>[]>();
  for (const claim of claimsForSession(root, session.sessionId)) {
    const current = grouped.get(claim.descriptor.name) ?? [];
    current.push(claim);
    grouped.set(claim.descriptor.name, current);
  }
  const conflicts: VoiceToolConflictDiagnostic[] = [];
  const tools: VoiceToolCatalogEntry[] = [];
  const selected = names ? new Set(names) : undefined;
  const unknownNames = names
    ? [...new Set(names)].filter((name) => !grouped.has(name)).slice(0, VOICE_TOOL_MAX_BATCH_ITEMS)
    : [];
  for (const [name, claims] of grouped) {
    if (selected && !selected.has(name)) continue;
    const fingerprints = new Set(claims.map((claim) => claim.fingerprint));
    if (fingerprints.size > 1) {
      conflicts.push({
        name,
        message: `Voice tool '${name}' has conflicting registrations.`,
        claims: claims
          .slice(0, VOICE_TOOL_MAX_BATCH_ITEMS)
          .map((claim) => ({ source: claim.descriptor.source, id: claim.descriptor.id })),
      });
      continue;
    }
    const descriptor = claims[0]?.descriptor;
    if (!descriptor) continue;
    tools.push({
      source: descriptor.source,
      id: descriptor.id,
      name: descriptor.name,
      label: descriptor.label,
      description: descriptor.description,
      order: descriptor.order,
      inputSchema: cloneJson(descriptor.inputSchema, VOICE_TOOL_MAX_SCHEMA_BYTES),
      enabled: session.active,
    });
  }
  if (names) {
    const requestedOrder = new Map([...new Set(names)].map((name, index) => [name, index]));
    tools.sort(
      (left, right) =>
        (requestedOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
        (requestedOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER),
    );
  } else {
    tools.sort(
      (left, right) =>
        left.order - right.order ||
        left.name.localeCompare(right.name) ||
        left.source.localeCompare(right.source) ||
        left.id.localeCompare(right.id),
    );
  }
  conflicts.sort((left, right) => left.name.localeCompare(right.name));
  return {
    hostGeneration: session.hostGeneration,
    catalogRevision: session.revision,
    catalogToken: catalogToken(session),
    tools,
    conflicts,
    unknownNames,
  };
}

function refreshSessions(root: VoiceToolRegistryRoot): void {
  for (const session of root.sessions.values()) {
    if (!session.disposed) {
      session.revision += 1;
      notify(session);
    }
  }
}

function notifySessionListeners(root: VoiceToolRegistryRoot, sessionId: string): void {
  const session = root.sessionHandles.get(sessionId);
  for (const listener of root.sessionListeners.get(sessionId) ?? []) listener(session);
}

function errorPayload(
  error: unknown,
  fallbackCode: VoiceToolErrorCode = 'VOICE_TOOL_EXECUTION_FAILED',
): VoiceToolErrorPayload {
  if (error instanceof VoiceToolError) {
    return {
      code: error.code,
      message: error.message.slice(0, VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH),
      retryable: error.retryable,
    };
  }
  return { code: fallbackCode, message: 'Voice tool execution failed.' };
}

function resultError(
  index: number,
  call: VoiceToolBatchCall,
  error: VoiceToolErrorPayload,
  status: VoiceToolBatchItemResult['status'] = 'failed',
): VoiceToolBatchItemResult {
  return { index, name: call.name, status, error };
}

function timeoutFor(claim: VoiceToolClaim<unknown>): number {
  return Math.min(claim.descriptor.timeoutMs ?? VOICE_TOOL_DEFAULT_TIMEOUT_MS, VOICE_TOOL_MAX_TIMEOUT_MS);
}

function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; controller: AbortController; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abort = (reason: unknown) => controller.abort(reason);
  const abortFromCaller = () => abort(signal?.reason ?? 'Voice tool call aborted.');
  const abortFromTimeout = () => abort(timeoutSignal.reason ?? 'Voice tool call timed out.');
  if (signal) {
    signal.addEventListener('abort', abortFromCaller, { once: true });
    if (signal.aborted) abortFromCaller();
  }
  timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true });
  return {
    signal: controller.signal,
    controller,
    timedOut: () => timeoutSignal.aborted,
    dispose: () => {
      signal?.removeEventListener('abort', abortFromCaller);
      timeoutSignal.removeEventListener('abort', abortFromTimeout);
    },
  };
}

function preflightInput(schema: TSchema, input: unknown): unknown {
  let cloned: unknown;
  try {
    cloned = cloneJson(input, VOICE_TOOL_MAX_INPUT_BYTES, 'Voice tool input exceeds its limit.');
    if (!Check(schema, cloned)) {
      const detail = Errors(schema, cloned)
        .slice(0, 2)
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      throw new VoiceToolError('VOICE_TOOL_INVALID_INPUT', `Voice tool input is invalid: ${detail}`);
    }
  } catch (error) {
    if (error instanceof VoiceToolError && error.code === 'VOICE_TOOL_INVALID_INPUT') throw error;
    throw new VoiceToolError('VOICE_TOOL_INVALID_INPUT', 'Voice tool input is invalid.');
  }
  return cloned;
}

function validateOutput(schema: TSchema, output: unknown): unknown {
  let cloned: unknown;
  try {
    cloned = cloneJson(output, VOICE_TOOL_MAX_INPUT_BYTES, 'Voice tool result exceeds its limit.');
    if (!Check(schema, cloned))
      throw new VoiceToolError('VOICE_TOOL_INVALID_RESULT', 'Voice tool returned an invalid result.');
  } catch (error) {
    if (error instanceof VoiceToolError && error.code === 'VOICE_TOOL_INVALID_RESULT') throw error;
    throw new VoiceToolError('VOICE_TOOL_INVALID_RESULT', 'Voice tool returned an invalid result.');
  }
  return cloned;
}

function requestErrors(session: VoiceToolSessionState<unknown>, input: VoiceToolUseInput): VoiceToolErrorPayload[] {
  const errors: VoiceToolErrorPayload[] = [];
  if (input.catalogToken !== catalogToken(session)) {
    errors.push({ code: 'VOICE_TOOL_STALE_CATALOG', message: 'The voice tool catalog is stale.', retryable: true });
  }
  if (!session.active)
    errors.push({ code: 'VOICE_TOOL_INACTIVE', message: 'Autonomous voice is not active.', retryable: true });
  return errors;
}

async function runBatch<Context>(
  root: VoiceToolRegistryRoot,
  session: VoiceToolSessionState<Context>,
  input: VoiceToolUseInput,
  context: Context,
  options: VoiceToolExecuteOptions,
): Promise<VoiceToolBatchResult> {
  const requestedOperationId = options.operationId ? validOperationId(options.operationId) : undefined;
  if (requestedOperationId) {
    const terminal = session.terminal.get(requestedOperationId);
    if (terminal) return cloneJson(terminal, VOICE_TOOL_MAX_BATCH_BYTES);
  }
  const globalErrors = requestErrors(session as VoiceToolSessionState<unknown>, input);
  if (input.calls.length > VOICE_TOOL_MAX_BATCH_ITEMS) {
    globalErrors.push({ code: 'VOICE_TOOL_INVALID_REQUEST', message: 'Voice tool batch contains too many calls.' });
  }
  let batchJson = '';
  try {
    batchJson = jsonText(input, VOICE_TOOL_MAX_JSON_DEPTH);
    if (new TextEncoder().encode(batchJson).byteLength > VOICE_TOOL_MAX_BATCH_BYTES) {
      globalErrors.push({ code: 'VOICE_TOOL_INVALID_REQUEST', message: 'Voice tool batch exceeds its limit.' });
    }
  } catch (error) {
    globalErrors.push(errorPayload(error, 'VOICE_TOOL_INVALID_REQUEST'));
  }
  void batchJson;

  const results: VoiceToolBatchItemResult[] = [];
  const preflight: Array<{
    call: VoiceToolBatchCall;
    claim?: VoiceToolClaim<unknown>;
    input?: unknown;
    error?: VoiceToolErrorPayload;
  }> = [];
  if (globalErrors.length === 0) {
    for (const [index, call] of input.calls.entries()) {
      const resolved = activeClaim(root, session.sessionId, call.name);
      if (resolved.conflict) {
        preflight.push({ call, error: { code: 'VOICE_TOOL_NAME_CONFLICT', message: resolved.conflict.message } });
        continue;
      }
      if (!resolved.claim) {
        preflight.push({
          call,
          error: { code: 'VOICE_TOOL_NOT_FOUND', message: `Unknown voice tool '${call.name}'.` },
        });
        continue;
      }
      if (
        !root.claims
          .get(call.name)
          ?.some((claim) => claim.registrationGeneration === resolved.claim?.registrationGeneration)
      ) {
        preflight.push({
          call,
          error: {
            code: 'VOICE_TOOL_REGISTRATION_DISPOSED',
            message: 'Voice tool registration was disposed.',
            retryable: true,
          },
        });
        continue;
      }
      try {
        preflight.push({
          call,
          claim: resolved.claim,
          input: preflightInput(resolved.claim.descriptor.inputSchema, call.input),
        });
      } catch (error) {
        preflight.push({ call, error: errorPayload(error, 'VOICE_TOOL_INVALID_INPUT') });
      }
      void index;
    }
  }
  if (globalErrors.length > 0 || preflight.some((item) => item.error)) {
    const errors = [...globalErrors, ...preflight.flatMap((item) => (item.error ? [item.error] : []))];
    for (const [index, call] of input.calls.entries()) {
      const item = preflight[index];
      results.push(
        item?.error
          ? resultError(index, call, item.error, 'preflight_failed')
          : resultError(
              index,
              call,
              errors[0] ?? { code: 'VOICE_TOOL_INVALID_REQUEST', message: 'Voice tool batch was rejected.' },
              'not_executed',
            ),
      );
    }
    const rejected: VoiceToolBatchResult = {
      status: 'rejected',
      catalogToken: catalogToken(session as VoiceToolSessionState<unknown>),
      results,
      errors: errors.slice(0, VOICE_TOOL_MAX_BATCH_ITEMS),
    };
    if (requestedOperationId) {
      session.terminal.set(requestedOperationId, rejected);
      while (session.terminal.size > VOICE_TOOL_TERMINAL_OPERATION_LIMIT)
        session.terminal.delete(session.terminal.keys().next().value as string);
    }
    return rejected;
  }

  root.sequence += 1;
  const operationId = requestedOperationId ?? validOperationId(`voice:${root.sequence}`);
  const batchSize = input.calls.length;
  let status: VoiceToolBatchResult['status'] = 'completed';
  for (const [index, item] of preflight.entries()) {
    if (session.disposed) {
      status = 'cancelled';
      results.push(
        resultError(
          index,
          item.call,
          { code: 'VOICE_TOOL_SESSION_SHUTDOWN', message: 'Voice session is shutting down.', retryable: true },
          'cancelled',
        ),
      );
      continue;
    }
    if (options.signal?.aborted) {
      status = 'cancelled';
      results.push(
        resultError(
          index,
          item.call,
          { code: 'VOICE_TOOL_CANCELLED', message: 'Voice tool batch was cancelled.', retryable: true },
          'cancelled',
        ),
      );
      continue;
    }
    const claim = item.claim;
    if (!claim || item.input === undefined) {
      results.push(
        resultError(index, item.call, {
          code: 'VOICE_TOOL_INVALID_REQUEST',
          message: 'Voice tool call was not prepared.',
        }),
      );
      continue;
    }
    const operationKey = `${operationId}:${index}`;
    const combined = combineSignal(options.signal, timeoutFor(claim));
    session.operations.set(operationKey, {
      controller: combined.controller,
      registrationGeneration: claim.registrationGeneration,
    });
    let itemResult: VoiceToolBatchItemResult;
    try {
      const value = await Promise.race([
        Promise.resolve(
          claim.execute(item.input, {
            sessionId: session.sessionId,
            hostGeneration: session.hostGeneration,
            operationId,
            batchIndex: index,
            batchSize,
            signal: combined.signal,
            context: claim.context ?? context,
          }),
        ),
        new Promise<never>((_, reject) => {
          combined.signal.addEventListener(
            'abort',
            () =>
              reject(
                new VoiceToolError(
                  combined.timedOut() ? 'VOICE_TOOL_TIMEOUT' : 'VOICE_TOOL_ABORTED',
                  combined.timedOut() ? 'Voice tool call timed out.' : 'Voice tool call was aborted.',
                  true,
                ),
              ),
            { once: true },
          );
        }),
      ]);
      if (session.disposed)
        throw new VoiceToolError('VOICE_TOOL_SESSION_SHUTDOWN', 'Voice session is shutting down.', true);
      if (!session.active) throw new VoiceToolError('VOICE_TOOL_INACTIVE', 'Autonomous voice is not active.', true);
      if (catalogToken(session as VoiceToolSessionState<unknown>) !== input.catalogToken) {
        throw new VoiceToolError('VOICE_TOOL_STALE_CATALOG', 'The voice tool catalog is stale.', true);
      }
      const currentClaim = activeClaim(root, session.sessionId, item.call.name);
      if (currentClaim.conflict) throw new VoiceToolError('VOICE_TOOL_NAME_CONFLICT', currentClaim.conflict.message);
      if (!currentClaim.claim || currentClaim.claim.registrationGeneration !== claim.registrationGeneration) {
        throw new VoiceToolError('VOICE_TOOL_REGISTRATION_DISPOSED', 'Voice tool registration was disposed.', true);
      }
      const result = validateOutput(claim.descriptor.resultSchema, value);
      itemResult = { index, name: item.call.name, status: 'completed', result };
      if (
        typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result) &&
        (result as { stopBatch?: unknown }).stopBatch === 'session-reload'
      ) {
        status = 'stopped';
      }
    } catch (error) {
      const payload = errorPayload(
        error,
        combined.timedOut()
          ? 'VOICE_TOOL_TIMEOUT'
          : options.signal?.aborted
            ? 'VOICE_TOOL_CANCELLED'
            : 'VOICE_TOOL_EXECUTION_FAILED',
      );
      const itemStatus: VoiceToolBatchItemResult['status'] =
        payload.code === 'VOICE_TOOL_CANCELLED' || payload.code === 'VOICE_TOOL_ABORTED' ? 'cancelled' : 'failed';
      if (itemStatus === 'cancelled') status = 'cancelled';
      itemResult = resultError(index, item.call, payload, itemStatus);
    } finally {
      combined.dispose();
      session.operations.delete(operationKey);
    }
    results.push(itemResult);
    if (status === 'stopped') {
      for (const [laterIndex, later] of preflight.entries()) {
        if (laterIndex <= index) continue;
        results.push(
          resultError(
            laterIndex,
            later.call,
            {
              code: 'VOICE_TOOL_BATCH_STOPPED',
              message: 'Batch stopped because a session reload was queued.',
              retryable: true,
            },
            'not_executed',
          ),
        );
      }
      break;
    }
  }
  results.sort((left, right) => left.index - right.index);
  const result: VoiceToolBatchResult = {
    status,
    catalogToken: catalogToken(session as VoiceToolSessionState<unknown>),
    results,
  };
  session.terminal.set(operationId, result as VoiceToolBatchResult);
  while (session.terminal.size > VOICE_TOOL_TERMINAL_OPERATION_LIMIT)
    session.terminal.delete(session.terminal.keys().next().value as string);
  return result;
}

function createSession<Context>(
  root: VoiceToolRegistryRoot,
  sessionId: string,
  context: Context | undefined,
): VoiceToolSessionHandle<Context> {
  root.sequence += 1;
  const state: VoiceToolSessionState<Context> = {
    token: Symbol(sessionId),
    sessionId,
    hostGeneration: `${root.generation}:voice-session:${root.sequence}`,
    context,
    active: false,
    revision: 0,
    disposed: false,
    operations: new Map(),
    terminal: new Map(),
    listeners: new Set(),
  };
  root.sessions.set(sessionId, state as VoiceToolSessionState<unknown>);
  const handle: VoiceToolSessionHandle<Context> = {
    sessionId,
    hostGeneration: state.hostGeneration,
    get active() {
      return state.active;
    },
    setActive(active) {
      if (state.disposed || state.active === active) return;
      state.active = active;
      state.revision += 1;
      if (!active) abortOperations(state as VoiceToolSessionState<unknown>, 'Voice host became inactive.');
      notify(state as VoiceToolSessionState<unknown>);
    },
    subscribe(listener) {
      if (state.disposed) return () => undefined;
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    describe(input = {}) {
      const names = input.names
        ? [
            ...new Set(
              input.names.map((name) =>
                normalizedText(name, 'voice tool name', VOICE_TOOL_MAX_IDENTIFIER_LENGTH, SAFE_NAME),
              ),
            ),
          ]
        : undefined;
      return catalog(root, state as VoiceToolSessionState<unknown>, names);
    },
    executeBatch(input, executeContext, options = {}) {
      if (state.disposed) {
        return Promise.resolve({
          status: 'rejected',
          catalogToken: catalogToken(state as VoiceToolSessionState<unknown>),
          results: input.calls.map((call, index) =>
            resultError(
              index,
              call,
              { code: 'VOICE_TOOL_SESSION_SHUTDOWN', message: 'Voice session is shutting down.', retryable: true },
              'not_executed',
            ),
          ),
          errors: [
            { code: 'VOICE_TOOL_SESSION_SHUTDOWN', message: 'Voice session is shutting down.', retryable: true },
          ],
        });
      }
      return runBatch(root, state, input, executeContext, options);
    },
    useVoiceTools(input, executeContext, options = {}) {
      return this.executeBatch(input, executeContext, options);
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.active = false;
      abortOperations(state as VoiceToolSessionState<unknown>, 'Voice host session disposed.');
      state.listeners.clear();
      if (root.sessions.get(sessionId) === state) root.sessions.delete(sessionId);
      if (root.sessionHandles.get(sessionId) === handle) root.sessionHandles.delete(sessionId);
      notifySessionListeners(root, sessionId);
    },
  };
  root.sessionHandles.set(sessionId, handle as VoiceToolSessionHandle<unknown>);
  notifySessionListeners(root, sessionId);
  return handle;
}

function registerDefinition<Context = unknown>(
  root: VoiceToolRegistryRoot,
  definition: VoiceToolDefinition<Context>,
  options: VoiceToolRegistrationOptions<Context> = {},
): VoiceToolRegistrationHandle {
  if (root.disposed) throw new VoiceToolError('VOICE_TOOL_HOST_UNAVAILABLE', 'Voice tools are disposed.');
  const descriptor = validateDescriptor(definition.descriptor);
  root.sequence += 1;
  const registrationGeneration = `${root.generation}:voice-tool:${root.sequence}`;
  const claim: VoiceToolClaim<Context> = {
    descriptor,
    execute: (input, execution) => definition.execute(input, execution),
    registrationGeneration,
    ...(options.sessionId === undefined ? {} : { sessionId: validSessionId(options.sessionId) }),
    ...(options.context === undefined ? {} : { context: options.context }),
    fingerprint: descriptorFingerprint(descriptor),
  };
  const key = descriptor.name;
  for (const [registeredName, registeredClaims] of root.claims) {
    const replaced = registeredClaims.filter(
      (candidate) => candidate.descriptor.source === descriptor.source && candidate.descriptor.id === descriptor.id,
    );
    if (replaced.length === 0) continue;
    for (const candidate of replaced) abortRegistrationOperations(root, candidate.registrationGeneration);
    const remaining = registeredClaims.filter((candidate) => !replaced.includes(candidate));
    if (remaining.length === 0) root.claims.delete(registeredName);
    else root.claims.set(registeredName, remaining);
  }
  const claims = root.claims.get(key) ?? [];
  claims.push(claim as VoiceToolClaim<unknown>);
  root.claims.set(key, claims);
  refreshSessions(root);
  let disposed = false;
  return {
    source: descriptor.source,
    id: descriptor.id,
    registrationGeneration,
    dispose() {
      if (disposed) return;
      disposed = true;
      abortRegistrationOperations(root, registrationGeneration);
      const current = root.claims.get(key);
      if (!current) return;
      const index = current.findIndex((candidate) => candidate.registrationGeneration === registrationGeneration);
      if (index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) root.claims.delete(key);
      refreshSessions(root);
    },
  };
}

/** Creates the Voice-owned live registrar and session service. */
export function createDoomVoiceToolsService<SessionContext = unknown>(
  generation: string,
): DoomVoiceToolsService<SessionContext> {
  const normalizedGeneration = normalizedText(generation, 'voice service generation', 256);
  const root: VoiceToolRegistryRoot = {
    generation: normalizedGeneration,
    claims: new Map(),
    sessions: new Map(),
    sessionHandles: new Map(),
    sessionListeners: new Map(),
    sequence: 0,
    disposed: false,
  };
  const service: DoomVoiceToolsService<SessionContext> = {
    generation: normalizedGeneration,
    register<ContributionContext = SessionContext>(
      definition: VoiceToolDefinition<ContributionContext>,
      options: VoiceToolRegistrationOptions<ContributionContext> = {},
    ) {
      return registerDefinition(root, definition, options);
    },
    bindSession(id, context) {
      if (root.disposed) throw new VoiceToolError('VOICE_TOOL_HOST_UNAVAILABLE', 'Voice tools are disposed.');
      const key = validSessionId(id);
      const existing = root.sessions.get(key);
      if (existing)
        throw new VoiceToolError('VOICE_TOOL_HOST_UNAVAILABLE', `Voice tool session '${key}' is already bound.`);
      return createSession(root, key, context);
    },
    readSession(id) {
      const key = validSessionId(id);
      return root.sessionHandles.get(key) as VoiceToolSessionHandle<SessionContext> | undefined;
    },
    subscribeSession(id, listener) {
      if (root.disposed) return () => undefined;
      const key = validSessionId(id);
      const listeners = root.sessionListeners.get(key) ?? new Set();
      listeners.add(listener as (session: VoiceToolSessionHandle<unknown> | undefined) => void);
      root.sessionListeners.set(key, listeners);
      listener(root.sessionHandles.get(key) as VoiceToolSessionHandle<SessionContext> | undefined);
      return () => {
        listeners.delete(listener as (session: VoiceToolSessionHandle<unknown> | undefined) => void);
        if (listeners.size === 0) root.sessionListeners.delete(key);
      };
    },
    dispose() {
      if (root.disposed) return;
      root.disposed = true;
      for (const session of root.sessionHandles.values()) session.dispose();
      for (const claim of root.claims.values()) {
        for (const registration of claim) {
          abortRegistrationOperations(root, registration.registrationGeneration);
        }
      }
      root.claims.clear();
      root.sessionListeners.clear();
    },
  };
  return Object.freeze(service);
}

export function readDoomVoiceToolsService(context: Context): DoomVoiceToolsService | undefined {
  return context.get(DOOM_VOICE_TOOLS_SERVICE) as DoomVoiceToolsService | undefined;
}

export function requireDoomVoiceToolsService(context: Context): DoomVoiceToolsService {
  const service = readDoomVoiceToolsService(context);
  if (!service) throw new Error('Doom voice tools are unavailable. Load @agimon-ai/doompi-voice.');
  return service;
}
