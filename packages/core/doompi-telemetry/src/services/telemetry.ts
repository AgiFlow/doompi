import { context, isSpanContextValid, trace, type Context, type Span } from '@opentelemetry/api';
import type {
  DoomTelemetry,
  DoomTelemetryAttributes,
  DoomTelemetryErrorOptions,
  DoomTelemetryEventLevel,
  DoomTelemetryHandle,
  DoomTelemetryOptions,
  DoomTelemetryRecord,
  DoomTelemetryRuntimeLoader,
  DoomTelemetryStatus,
  DoomTraceContext,
} from '../types/telemetry.js';

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_WARNING_DETAIL_LENGTH = 512;
const MAX_WARNING_DETAIL_DEPTH = 3;
const MAX_ATTRIBUTE_STRING_LENGTH = 128;
const MAX_REPORTED_FAILURES = 500;
const MAX_EVENT_NAME_LENGTH = 128;
const SESSION_ID_HEADERS = ['AGENT_SESSION_ID', 'PI_SESSION_ID'] as const;
const PARENT_SESSION_ID_HEADERS = ['AGENT_PARENT_SESSION_ID', 'PARENT_AGENT_SESSION_ID'] as const;
const TRANSPORT_SESSION_HEADERS = ['PI_SESSION_ID', 'AGENT_PARENT_SESSION_ID'] as const;
const TRUE_VALUES = new Set(['1', 'true', 'yes']);
const SPAN_STATUS_ERROR = 2;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const SENSITIVE_ATTRIBUTE_PARTS = [
  'prompt',
  'message',
  'content',
  'payload',
  'command',
  'cwd',
  'path',
  'file',
  'stack',
  'traceback',
  'transcript',
  'diff',
  'secret',
  'authorization',
  'header',
  'environment',
  'env',
  'details',
  'args',
] as const;
const SAFE_RESULT_KEYS = new Set([
  'tool.result.error',
  'tool.result.count',
  'tool.result.bytes',
  'tool.result.duration_ms',
]);
const SAFE_METADATA_KEY_PARTS = new Set([
  'count',
  'length',
  'bytes',
  'duration',
  'duration_ms',
  'size',
  'index',
  'number',
  'active',
  'enabled',
  'previous',
  'empty',
  'silent',
  'fallback',
  'bypass',
  'success',
  'is_error',
  'has_ui',
  'requires_confirmation',
  'exit_code',
  'status_code',
  'interval_seconds',
  'concurrency',
  'budget',
]);
const SAFE_INPUT_KEYS = new Set([
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.total_tokens',
  'gen_ai.usage.cache_read_tokens',
  'gen_ai.usage.cache_write_tokens',
  'gen_ai.usage.reasoning_tokens',
]);
const SAFE_IDENTIFIER_KEY_PARTS = [
  'id',
  'correlation',
  'session',
  'trace',
  'span',
  'call',
  'run',
  'job',
  'step',
] as const;
const SAFE_STRING_KEY_PARTS = [
  'name',
  'operation',
  'outcome',
  'reason',
  'status',
  'mode',
  'source',
  'phase',
  'engine',
  'provider',
  'model',
  'level',
  'type',
  'code',
  'signal',
  'finish_reasons',
  'trigger',
  'action',
  'kind',
  'version',
  'scope',
  'layer',
  'profile',
  'domain',
  'theme',
  'leader',
  'pass',
  'role',
  'stage',
  'state',
  'language',
  'transport',
  'adapter',
  'runtime',
  'backend',
  'launcher',
  'event',
  'component',
  'package',
  'command_name',
  'tool_name',
  'token_attribution',
] as const;

const recordObservers = new Set<(record: DoomTelemetryRecord) => void>();

export function subscribeTelemetryRecords(observer: (record: DoomTelemetryRecord) => void): () => void {
  recordObservers.add(observer);
  return () => recordObservers.delete(observer);
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.toLowerCase());
}

function normalizeToken(value: string, fallback: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
  return normalized || fallback;
}

function hashIdentifier(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `id_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isSafeMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return [...SAFE_METADATA_KEY_PARTS].some(
    (part) => normalized === part || normalized.endsWith(`.${part}`) || normalized.endsWith(`_${part}`),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SAFE_RESULT_KEYS.has(normalized) || SAFE_INPUT_KEYS.has(normalized) || isSafeMetadataKey(normalized))
    return false;
  return SENSITIVE_ATTRIBUTE_PARTS.some((part) => normalized.split(/[._-]/u).includes(part));
}

function hasSafeStringMeaning(key: string): boolean {
  const normalized = key.toLowerCase();
  return SAFE_STRING_KEY_PARTS.some(
    (part) => normalized === part || normalized.endsWith(`.${part}`) || normalized.endsWith(`_${part}`),
  );
}

function hasSafeIdentifierMeaning(key: string): boolean {
  const normalized = key.toLowerCase();
  return SAFE_IDENTIFIER_KEY_PARTS.some(
    (part) => normalized === part || normalized.endsWith(`.${part}`) || normalized.endsWith(`_${part}`),
  );
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function sanitizeValue(key: string, value: string | number | boolean): string | number | boolean | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (value.length === 0 || value.length > MAX_ATTRIBUTE_STRING_LENGTH) return undefined;
  if (hasSafeIdentifierMeaning(key)) return hashIdentifier(value);
  if (!hasSafeStringMeaning(key)) return undefined;
  if (key === 'telemetry.package' || key.endsWith('.package')) {
    if (value.startsWith('/') || value.includes('\\')) return undefined;
    return value.replace(/[^a-zA-Z0-9@/._:-]/g, '_');
  }
  return normalizeToken(value, 'unknown');
}

export function sanitizeTelemetryAttributes(attributes: Record<string, unknown> = {}): DoomTelemetryAttributes {
  const sanitized: DoomTelemetryAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveKey(key) || !isScalar(value)) continue;
    const safeValue = sanitizeValue(key, value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return sanitized;
}

function safeErrorToken(value: string, fallback: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9._:-]{0,63}$/u.test(value)) return fallback;
  return normalizeToken(value, fallback);
}

function errorType(error: unknown): string {
  if (error instanceof Error) return safeErrorToken(error.name, 'Error');
  if (typeof error === 'string') return 'StringError';
  if (error && typeof error === 'object') return 'ObjectError';
  return 'UnknownError';
}

/**
 * Format an error for a local diagnostic warning.
 *
 * Deliberately separate from errorType: that produces a redacted token for the
 * exported `error.type` attribute and must stay metadata-only, whereas warnings
 * go to the local operator and are useless without the actual cause. Arrays are
 * unwrapped because OpenTelemetry's forceFlush rejects with one.
 */
function describeError(error: unknown, depth = 0): string {
  if (depth > MAX_WARNING_DETAIL_DEPTH) return '...';
  if (Array.isArray(error)) return error.map((entry) => describeError(entry, depth + 1)).join('; ');
  if (error instanceof Error) {
    const rawCode = 'code' in error ? (error as { code?: unknown }).code : undefined;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? ` (code ${rawCode})` : '';
    const aggregate = error instanceof AggregateError ? `: ${describeError(error.errors, depth + 1)}` : '';
    const cause = error.cause === undefined ? '' : ` <- caused by ${describeError(error.cause, depth + 1)}`;
    return `${error.name}: ${error.message}${code}${aggregate}${cause}`;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return 'ObjectError';
    }
  }
  return String(error);
}

function warningDetail(error: unknown): string {
  return describeError(error).slice(0, MAX_WARNING_DETAIL_LENGTH);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' && typeof code !== 'number') return undefined;
  const normalized = String(code);
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/u.test(normalized) ? normalizeToken(normalized, 'unknown') : undefined;
}

function errorAttributes(error: unknown): DoomTelemetryAttributes {
  const attributes: DoomTelemetryAttributes = {
    'error.type': errorType(error),
    outcome: 'error',
  };
  const code = errorCode(error);
  if (code) attributes['error.code'] = code;
  return attributes;
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function createTelemetryHeaders(serviceName: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { 'x-agent': normalizeToken(serviceName, 'doom') };
  const sessionId = firstEnvironmentValue(env, SESSION_ID_HEADERS);
  const parentSessionId = firstEnvironmentValue(env, PARENT_SESSION_ID_HEADERS);
  if (sessionId) headers['x-agent-session-id'] = hashIdentifier(sessionId);
  if (parentSessionId) headers['x-agent-parent-session-id'] = hashIdentifier(parentSessionId);
  return headers;
}

function createTransportEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const transportEnv = { ...env };
  const sessionId = firstEnvironmentValue(env, SESSION_ID_HEADERS);
  const parentSessionId = firstEnvironmentValue(env, PARENT_SESSION_ID_HEADERS);
  if (sessionId) transportEnv.AGENT_SESSION_ID = hashIdentifier(sessionId);
  else delete transportEnv.AGENT_SESSION_ID;
  if (parentSessionId) transportEnv.PARENT_AGENT_SESSION_ID = hashIdentifier(parentSessionId);
  else delete transportEnv.PARENT_AGENT_SESSION_ID;
  for (const key of TRANSPORT_SESSION_HEADERS) delete transportEnv[key];
  for (const key of Object.keys(transportEnv)) {
    if (key.startsWith('WORKFLOW_')) delete transportEnv[key];
  }
  return transportEnv;
}

function defaultStatus(options: DoomTelemetryOptions): DoomTelemetryStatus {
  return {
    serviceName: options.serviceName,
    packageName: options.packageName,
    backend: 'disabled',
    enabled: false,
    endpointSource: 'none',
    traces: false,
    fileFallback: false,
  };
}

function createSafeCallbackError(error: unknown): Error {
  return new Error(`Doom telemetry callback failed: ${errorType(error)}`);
}

function parentContext(parent: DoomTraceContext | undefined): Context | undefined {
  if (!parent) return undefined;
  const match = TRACEPARENT_PATTERN.exec(parent.traceparent);
  if (!match) return undefined;
  const [, traceId, spanId, traceFlags] = match;
  if (!traceId || !spanId || !traceFlags) return undefined;
  const spanContext = { traceId, spanId, traceFlags: Number.parseInt(traceFlags, 16), isRemote: true };
  return isSpanContextValid(spanContext) ? trace.setSpanContext(context.active(), spanContext) : undefined;
}

function childTraceContext(span: Span | undefined): DoomTraceContext | undefined {
  if (!span) return undefined;
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return undefined;
  const traceFlags = spanContext.traceFlags.toString(16).padStart(2, '0');
  return { traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}` };
}
export function createDoomTelemetryService(
  options: DoomTelemetryOptions,
  runtimeLoader?: DoomTelemetryRuntimeLoader,
): DoomTelemetry {
  const env = options.env ?? process.env;
  const telemetryFactory = options.telemetryFactory;
  const endpointResolver = options.endpointResolver;
  const transportEnv = createTransportEnvironment(env);
  const warn = options.warn ?? ((message: string) => process.emitWarning(message));
  const reportWarning = (message: string): void => {
    try {
      warn(message);
    } catch (error) {
      process.emitWarning(`Doom telemetry warning callback failed: ${warningDetail(error)}`);
    }
  };
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const allowFileFallback = options.allowFileFallback ?? isTruthy(env.LOG_SINK_PI_FILE_FALLBACK);
  const defaultTelemetryStatus = defaultStatus(options);
  let currentStatus = defaultTelemetryStatus;
  let handle: DoomTelemetryHandle | undefined;
  let initialization: Promise<DoomTelemetryHandle | undefined> | undefined;
  let retryAfter = 0;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownRequested = false;
  const reportedFailures = new Set<string>();

  const disabledByEnvironment = (): boolean =>
    isTruthy(env.AGENT_TELEMETRY_DISABLED) || isTruthy(env.OTEL_SDK_DISABLED);

  const publish = (record: DoomTelemetryRecord): void => {
    for (const observer of [...recordObservers, ...(options.onRecord ? [options.onRecord] : [])]) {
      try {
        observer(record);
      } catch (error) {
        reportWarning(`Doom telemetry observer failed: ${warningDetail(error)}`);
      }
    }
  };

  const initialize = async (): Promise<DoomTelemetryHandle | undefined> => {
    if (disabledByEnvironment() || shutdownRequested) return undefined;
    const defaults = telemetryFactory && endpointResolver ? undefined : await runtimeLoader?.();
    const resolveEndpoints = endpointResolver ?? defaults?.resolveNodeTelemetryEndpoints;
    const createTelemetry = telemetryFactory ?? defaults?.createNodeTelemetry;
    if (!resolveEndpoints || !createTelemetry) throw new Error('Node telemetry runtime is unavailable.');
    const resolvedEndpoints =
      options.telemetryFactory && !options.endpointResolver
        ? undefined
        : await resolveEndpoints({
            cwd: options.cwd,
            env,
            packageName: options.packageName,
            serviceName: options.serviceName,
            workspaceRoot: options.workspaceRoot,
            discoverEndpoint: true,
            healthCheck: true,
          });
    const endpoints = resolvedEndpoints ?? { endpointSource: 'env' as const, endpoint: 'injected' };
    if (!endpoints.endpoint && !endpoints.tracesEndpoint && !endpoints.logsEndpoint && !allowFileFallback) {
      retryAfter = Date.now() + retryDelayMs;
      currentStatus = { ...defaultTelemetryStatus };
      return undefined;
    }
    const nextHandle = await createTelemetry({
      serviceName: options.serviceName,
      packageName: options.packageName,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      env: transportEnv,
      discoverEndpoint: resolvedEndpoints === undefined,
      resolvedEndpoints,
      enableLogs: options.enableLogs ?? true,
      enableTraces: options.enableTraces ?? true,
      headers: createTelemetryHeaders(options.serviceName, env),
    });
    if (shutdownRequested) {
      await nextHandle.shutdown().catch((error: unknown) => {
        reportWarning(`Doom telemetry late initialization shutdown failed: ${warningDetail(error)}`);
      });
      return undefined;
    }
    if (nextHandle.backend === 'file' && !allowFileFallback) {
      await nextHandle
        .shutdown()
        .catch((error: unknown) => reportWarning(`Doom telemetry fallback shutdown failed: ${warningDetail(error)}`));
      currentStatus = { ...defaultTelemetryStatus };
      return undefined;
    }
    handle = nextHandle;
    currentStatus = {
      serviceName: options.serviceName,
      packageName: options.packageName,
      backend: nextHandle.backend,
      enabled: nextHandle.enabled,
      endpoint: nextHandle.endpoint,
      endpointSource: nextHandle.endpointSource,
      traces: Boolean(options.enableTraces ?? true),
      fileFallback: nextHandle.backend === 'file',
    };
    try {
      options.onStatus?.({ ...currentStatus });
    } catch (error) {
      reportWarning(`Doom telemetry status observer failed: ${warningDetail(error)}`);
    }
    return nextHandle;
  };

  const getHandle = async (): Promise<DoomTelemetryHandle | undefined> => {
    if (disabledByEnvironment() || shutdownRequested) return undefined;
    if (handle) return handle;
    if (Date.now() < retryAfter) return undefined;
    initialization ??= initialize()
      .catch((error: unknown) => {
        retryAfter = Date.now() + retryDelayMs;
        reportWarning(`Doom telemetry initialization failed: ${warningDetail(error)}`);
        return undefined;
      })
      .finally(() => {
        initialization = undefined;
      });
    return initialization;
  };

  const emit = async (
    level: DoomTelemetryEventLevel,
    event: string,
    error: unknown,
    attributes: Record<string, unknown> | undefined,
    errorOptions?: DoomTelemetryErrorOptions,
  ): Promise<void> => {
    const safeEvent = normalizeToken(event, 'doom.telemetry.event').slice(0, MAX_EVENT_NAME_LENGTH);
    const safeAttributes = sanitizeTelemetryAttributes({
      'telemetry.package': options.packageName,
      ...attributes,
      ...(error === undefined ? {} : errorAttributes(error)),
    });
    if (error !== undefined) {
      const failureKey = `${safeEvent}:${level}:${JSON.stringify(safeAttributes)}`;
      if (reportedFailures.has(failureKey)) return;
      if (reportedFailures.size >= MAX_REPORTED_FAILURES) reportedFailures.clear();
      reportedFailures.add(failureKey);
    }
    const record: DoomTelemetryRecord = { event: safeEvent, level, attributes: safeAttributes };
    publish(record);
    try {
      const nextHandle = await getHandle();
      nextHandle?.logger[level](safeEvent, {
        attributes: safeAttributes,
        ...(errorOptions?.includeException === true && error !== undefined ? { exception: error } : {}),
      });
    } catch (failure) {
      reportWarning(`Doom telemetry record failed: ${warningDetail(failure)}`);
    }
  };

  const flush = async (): Promise<void> => {
    try {
      const pendingInitialization = initialization;
      if (pendingInitialization) await pendingInitialization;
      await handle?.flush();
    } catch (error) {
      reportWarning(`Doom telemetry flush failed: ${warningDetail(error)}`);
    }
  };

  return {
    recordDebug(event, attributes) {
      return emit('debug', event, undefined, attributes);
    },
    recordEvent(event, attributes) {
      return emit('info', event, undefined, attributes);
    },
    recordWarning(event, error, attributes) {
      return emit('warn', event, error, attributes);
    },
    recordError(event, error, attributes, errorOptions) {
      return emit('error', event, error, attributes, errorOptions);
    },
    async runInSpan<T>(
      name: string,
      attributes: Record<string, unknown>,
      callback: (context?: DoomTraceContext) => Promise<T> | T,
      parent?: DoomTraceContext,
    ) {
      let callbackPromise: Promise<T> | undefined;
      let callbackFailure: { value: unknown } | undefined;
      const invokeCallback = (child?: DoomTraceContext): Promise<T> => {
        callbackPromise ??= Promise.resolve().then(() => callback(child));
        return callbackPromise;
      };
      const nextHandle = await getHandle();
      if (!nextHandle) return invokeCallback();
      const startedAt = Date.now();
      try {
        const nextParentContext = parentContext(parent);
        return await nextHandle.runInSpan(
          normalizeToken(name, 'doom.telemetry.span'),
          {
            attributes: sanitizeTelemetryAttributes(attributes),
            ...(nextParentContext ? { context: nextParentContext } : {}),
          },
          async (span) => {
            const child = childTraceContext(span);
            try {
              const result = await invokeCallback(child);
              span?.setAttribute('duration_ms', Date.now() - startedAt);
              span?.setAttribute('outcome', 'success');
              return result;
            } catch (error) {
              callbackFailure = { value: error };
              const safeError = errorAttributes(error);
              for (const [key, value] of Object.entries(safeError)) span?.setAttribute(key, value);
              span?.setAttribute('duration_ms', Date.now() - startedAt);
              span?.setStatus({ code: SPAN_STATUS_ERROR });
              throw createSafeCallbackError(error);
            }
          },
        );
      } catch (error) {
        if (callbackFailure) return Promise.reject(callbackFailure.value);
        if (callbackPromise) return callbackPromise;
        reportWarning(`Doom telemetry span failed: ${warningDetail(error)}`);
        return invokeCallback();
      }
    },
    flush,
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownRequested = true;
      shutdownPromise = (async () => {
        await flush();
        const currentHandle = handle;
        handle = undefined;
        if (!currentHandle) return;
        try {
          await currentHandle.shutdown();
        } catch (error) {
          reportWarning(`Doom telemetry shutdown failed: ${warningDetail(error)}`);
        }
      })();
      return shutdownPromise;
    },
    status() {
      return { ...currentStatus };
    },
  };
}
