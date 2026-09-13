import { type Static, type TSchema, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

export const DOOM_PROTOCOL_ERROR_CODE = {
  aborted: 'ABORTED',
  invalidMessage: 'INVALID_MESSAGE',
  providerError: 'PROVIDER_ERROR',
  timeout: 'TIMEOUT',
} as const;

const DEFAULT_PROTOCOL_TIMEOUT_MS = 5_000;
const DEFAULT_DUPLICATE_WINDOW = 256;

export interface EventBusLike {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;
}

export const ProtocolErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type ProtocolErrorPayload = Static<typeof ProtocolErrorSchema>;

export class DoomProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(payload: ProtocolErrorPayload) {
    super(payload.message);
    this.name = 'DoomProtocolError';
    this.code = payload.code;
    this.retryable = payload.retryable ?? false;
  }
}

export class DoomProtocolValidationError extends DoomProtocolError {
  constructor(channel: string, details: string) {
    super({ code: DOOM_PROTOCOL_ERROR_CODE.invalidMessage, message: `Invalid message on ${channel}: ${details}` });
    this.name = 'DoomProtocolValidationError';
  }
}

export interface ProtocolIdentity {
  source: string;
  sessionId: string;
}

interface ProtocolEnvelope<TPayload> extends ProtocolIdentity {
  protocol: string;
  version: 1;
  kind: string;
  messageId: string;
  correlationId?: string;
  payload: TPayload;
}

export interface NotificationDefinition<TPayload extends TSchema> {
  channel: string;
  kind: string;
  payload: TPayload;
}

export interface RequestReplyDefinition<TRequest extends TSchema, TResponse extends TSchema> {
  requestChannel: string;
  responseChannel: string;
  errorChannel: string;
  requestKind: string;
  responseKind: string;
  request: TRequest;
  response: TResponse;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Ignore correlated replies from any source except this exact provider. */
  expectedSource?: string;
}

export interface ProtocolRuntimeOptions extends ProtocolIdentity {
  bus: EventBusLike;
  defaultTimeoutMs?: number;
  createMessageId?: () => string;
  duplicateWindow?: number;
}

export interface ProtocolRuntime {
  notify<TPayload extends TSchema>(definition: NotificationDefinition<TPayload>, payload: Static<TPayload>): void;
  onNotification<TPayload extends TSchema>(
    definition: NotificationDefinition<TPayload>,
    handler: (payload: Static<TPayload>, identity: ProtocolIdentity) => void | Promise<void>,
  ): () => void;
  request<TRequest extends TSchema, TResponse extends TSchema>(
    definition: RequestReplyDefinition<TRequest, TResponse>,
    payload: Static<TRequest>,
    options?: RequestOptions,
  ): Promise<Static<TResponse>>;
  provide<TRequest extends TSchema, TResponse extends TSchema>(
    definition: RequestReplyDefinition<TRequest, TResponse>,
    handler: (payload: Static<TRequest>, identity: ProtocolIdentity) => Static<TResponse> | Promise<Static<TResponse>>,
  ): () => void;
}

const EnvelopeBaseSchema = Type.Object(
  {
    protocol: Type.String({ minLength: 1 }),
    version: Type.Literal(1),
    kind: Type.String({ minLength: 1 }),
    messageId: Type.String({ minLength: 1 }),
    correlationId: Type.Optional(Type.String({ minLength: 1 })),
    source: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

function envelopeSchema<TPayload extends TSchema>(payload: TPayload) {
  return Type.Object({ ...EnvelopeBaseSchema.properties, payload }, { additionalProperties: false });
}

function protocolName(channel: string): string {
  const match = /^(doom:[^:]+(?::[^:]+)*):v\d+:/.exec(channel);
  if (!match) throw new Error(`Invalid Doom protocol channel: ${channel}`);
  return match[1];
}

function validationDetails(schema: TSchema, value: unknown): string {
  return Errors(schema, value)
    .slice(0, 3)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

function assertValid<TSchemaValue extends TSchema>(
  channel: string,
  schema: TSchemaValue,
  value: unknown,
): asserts value is Static<TSchemaValue> {
  if (!Check(schema, value)) throw new DoomProtocolValidationError(channel, validationDetails(schema, value));
}

function asProtocolError(error: unknown): ProtocolErrorPayload {
  if (error instanceof DoomProtocolError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: DOOM_PROTOCOL_ERROR_CODE.providerError,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function defineNotification<TPayload extends TSchema>(definition: {
  channel: `doom:${string}:${string}:v1:${string}`;
  kind: string;
  payload: TPayload;
}): NotificationDefinition<TPayload> {
  protocolName(definition.channel);
  return definition;
}

export function defineRequestReply<TRequest extends TSchema, TResponse extends TSchema>(definition: {
  channels: {
    request: `doom:${string}:${string}:v1:${string}`;
    response: `doom:${string}:${string}:v1:${string}`;
    error: `doom:${string}:${string}:v1:${string}`;
  };
  kinds: { request: string; response: string };
  request: TRequest;
  response: TResponse;
}): RequestReplyDefinition<TRequest, TResponse> {
  const protocol = protocolName(definition.channels.request);
  for (const channel of [definition.channels.response, definition.channels.error]) {
    if (protocolName(channel) !== protocol) throw new Error('Request/reply channels must share one protocol');
  }
  return {
    requestChannel: definition.channels.request,
    responseChannel: definition.channels.response,
    errorChannel: definition.channels.error,
    requestKind: definition.kinds.request,
    responseKind: definition.kinds.response,
    request: definition.request,
    response: definition.response,
  };
}

export const defineJob = defineRequestReply;

export function createProtocolRuntime(options: ProtocolRuntimeOptions): ProtocolRuntime {
  const timeoutDefault = options.defaultTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS;
  const duplicateWindow = options.duplicateWindow ?? DEFAULT_DUPLICATE_WINDOW;
  const createMessageId = options.createMessageId ?? (() => `${options.source}:${crypto.randomUUID()}`);

  const rethrowAsync = (error: unknown): void => {
    queueMicrotask(() => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  };

  function duplicateGuard(): (messageId: string) => boolean {
    const handled = new Set<string>();
    return (messageId) => {
      if (handled.has(messageId)) return false;
      handled.add(messageId);
      if (handled.size > duplicateWindow) handled.delete(handled.values().next().value as string);
      return true;
    };
  }

  function base(channel: string, kind: string, messageId = createMessageId(), correlationId?: string) {
    return {
      protocol: protocolName(channel),
      version: 1 as const,
      kind,
      messageId,
      ...(correlationId ? { correlationId } : {}),
      source: options.source,
      sessionId: options.sessionId,
    };
  }

  return {
    notify<TPayload extends TSchema>(definition: NotificationDefinition<TPayload>, payload: Static<TPayload>) {
      assertValid(definition.channel, definition.payload, payload);
      options.bus.emit(definition.channel, { ...base(definition.channel, definition.kind), payload });
    },

    onNotification<TPayload extends TSchema>(
      definition: NotificationDefinition<TPayload>,
      handler: (payload: Static<TPayload>, identity: ProtocolIdentity) => void | Promise<void>,
    ) {
      const schema = envelopeSchema(definition.payload);
      const remember = duplicateGuard();
      return options.bus.on(definition.channel, (message) => {
        assertValid(definition.channel, schema, message);
        const envelope = message as unknown as ProtocolEnvelope<Static<TPayload>>;
        if (envelope.sessionId !== options.sessionId) return;
        if (!remember(envelope.messageId)) return;
        void Promise.resolve(handler(envelope.payload, envelope)).catch(rethrowAsync);
      });
    },

    request<TRequest extends TSchema, TResponse extends TSchema>(
      definition: RequestReplyDefinition<TRequest, TResponse>,
      payload: Static<TRequest>,
      requestOptions: RequestOptions = {},
    ) {
      assertValid(definition.requestChannel, definition.request, payload);
      const messageId = createMessageId();
      const responseSchema = envelopeSchema(definition.response);
      const errorSchema = envelopeSchema(ProtocolErrorSchema);
      return new Promise<Static<typeof definition.response>>((resolve, reject) => {
        let settled = false;
        const cleanups: Array<() => void> = [];
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          for (const cleanup of cleanups.splice(0)) cleanup();
          action();
        };
        cleanups.push(
          options.bus.on(definition.responseChannel, (message) => {
            assertValid(definition.responseChannel, responseSchema, message);
            const envelope = message as unknown as ProtocolEnvelope<Static<TResponse>>;
            if (envelope.sessionId !== options.sessionId) return;
            if (envelope.correlationId !== messageId) return;
            if (requestOptions.expectedSource && envelope.source !== requestOptions.expectedSource) return;
            finish(() => resolve(envelope.payload));
          }),
          options.bus.on(definition.errorChannel, (message) => {
            assertValid(definition.errorChannel, errorSchema, message);
            const envelope = message as unknown as ProtocolEnvelope<ProtocolErrorPayload>;
            if (envelope.sessionId !== options.sessionId) return;
            if (envelope.correlationId !== messageId) return;
            if (requestOptions.expectedSource && envelope.source !== requestOptions.expectedSource) return;
            finish(() => reject(new DoomProtocolError(envelope.payload)));
          }),
        );
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new DoomProtocolError({
                  code: DOOM_PROTOCOL_ERROR_CODE.timeout,
                  message: `Timed out waiting for ${definition.responseKind}`,
                }),
              ),
            ),
          requestOptions.timeoutMs ?? timeoutDefault,
        );
        cleanups.push(() => clearTimeout(timer));
        if (requestOptions.signal) {
          const abort = () =>
            finish(() =>
              reject(new DoomProtocolError({ code: DOOM_PROTOCOL_ERROR_CODE.aborted, message: 'Request aborted' })),
            );
          requestOptions.signal.addEventListener('abort', abort, { once: true });
          cleanups.push(() => requestOptions.signal?.removeEventListener('abort', abort));
          if (requestOptions.signal.aborted) return abort();
        }
        options.bus.emit(definition.requestChannel, {
          ...base(definition.requestChannel, definition.requestKind, messageId),
          payload,
        });
      });
    },

    provide<TRequest extends TSchema, TResponse extends TSchema>(
      definition: RequestReplyDefinition<TRequest, TResponse>,
      handler: (
        payload: Static<TRequest>,
        identity: ProtocolIdentity,
      ) => Static<TResponse> | Promise<Static<TResponse>>,
    ) {
      const requestSchema = envelopeSchema(definition.request);
      const remember = duplicateGuard();
      return options.bus.on(definition.requestChannel, (message) => {
        assertValid(definition.requestChannel, requestSchema, message);
        const envelope = message as unknown as ProtocolEnvelope<Static<TRequest>>;
        if (envelope.sessionId !== options.sessionId) return;
        if (!remember(envelope.messageId)) return;
        void Promise.resolve()
          .then(() => handler(envelope.payload, envelope))
          .then(
            (payload) => {
              assertValid(definition.responseChannel, definition.response, payload);
              options.bus.emit(definition.responseChannel, {
                ...base(definition.responseChannel, definition.responseKind, createMessageId(), envelope.messageId),
                payload,
              });
            },
            (error) => {
              options.bus.emit(definition.errorChannel, {
                ...base(definition.errorChannel, 'error', createMessageId(), envelope.messageId),
                payload: asProtocolError(error),
              });
            },
          );
      });
    },
  };
}
