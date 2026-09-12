/**
 * In-process peer messaging for one root session's native Team children.
 *
 * Native Pi children share the host's child-session service, so intercom state
 * lives here, in the owning Team channel. External runtimes do not join this
 * channel: they are explicit one-shot subprocesses with no filesystem fallback.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  DoomChildSessionIntercom,
  DoomChildSessionRuntime,
  DoomChildSessionTool,
  DoomChildSessionToolResult,
} from '@agimon-ai/doompi-extension-contracts/child-session';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { BoundedKeySet } from '../boundedKeySet';
import { DoomTeamExpectedError, invalidRequest } from '../errors';

/** Wire literal. The model calls the tool by this name, so it is not renamed. */
export const NATIVE_TEAM_TOOL_NAME = 'intercom';

const TEAM_MESSAGE_CUSTOM_TYPE = 'intercom_message';
const MAIN_MEMBER_ID = 'main';
const RESERVED_NAME_FALLBACK = 'main-agent';
const FALLBACK_MEMBER_NAME = 'agent';
const MAX_MEMBER_NAME_LENGTH = 48;
const FANOUT_SUFFIX_SEPARATOR = '-';
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_KEYS = 1024;
const HASH_ALGORITHM = 'sha256';
const TOKEN_BYTES = 32;
const TEAM_ID_PREFIX = 'session-';
const TEAM_ROOT_VERSION = 1;

const TEAM_ACTIONS = ['members', 'send', 'ask', 'reply', 'pending'] as const;
const UNSAFE_NAME_CHARS = /[^a-z0-9._-]+/g;
const SURROUNDING_SEPARATORS = /^[-.]+|[-.]+$/g;

export type TeamMemberRole = 'main' | 'subagent';

export interface TeamRootContext {
  version: typeof TEAM_ROOT_VERSION;
  teamId: string;
  rootSessionId: string;
  mainMemberId: string;
}

export interface TeamTaskMetadata {
  id: string;
  subject: string;
}

export interface TeamMemberContext extends TeamRootContext {
  memberId: string;
  /** Kept in the direct context for capability identity, never forwarded through env or files. */
  token: string;
  role: TeamMemberRole;
  agent?: string;
  runId?: string;
  childIndex?: number;
  parentMemberId?: string;
  task?: TeamTaskMetadata;
}

export interface NativeTeamMemberSnapshot {
  name: string;
  role: TeamMemberRole;
  agent?: string;
  runId?: string;
  task?: TeamTaskMetadata;
}

export interface NativeTeamSnapshot {
  members: NativeTeamMemberSnapshot[];
}

interface TeamToolParams {
  action: (typeof TEAM_ACTIONS)[number];
  to?: string;
  message?: string;
  requestId?: string;
  timeoutMs?: number;
}

export const TeamToolParamsSchema = {
  oneOf: [
    ...(['members', 'pending'] as const).map((action) => ({
      type: 'object',
      properties: { action: { const: action } },
      required: ['action'],
      additionalProperties: false,
    })),
    {
      type: 'object',
      properties: { action: { const: 'send' }, to: { type: 'string' }, message: { type: 'string' } },
      required: ['action', 'to', 'message'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { const: 'ask' },
        to: { type: 'string' },
        message: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      required: ['action', 'to', 'message'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: { const: 'reply' }, requestId: { type: 'string' }, message: { type: 'string' } },
      required: ['action', 'requestId', 'message'],
      additionalProperties: false,
    },
  ],
} as unknown as TSchema;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function withinBytes(value: string, limit: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= limit;
}

function hash(value: string): string {
  return createHash(HASH_ALGORITHM).update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function teamIdForSession(rootSessionId: string): string {
  return `${TEAM_ID_PREFIX}${hash(rootSessionId).slice(0, 32)}`;
}

function operationMessageId(memberId: string, operationId: string): string {
  return hash(`${memberId}:${operationId}`);
}

function guardReservedName(name: string, explicit: boolean): string {
  if (name !== MAIN_MEMBER_ID) return name;
  if (explicit) throw new Error(`Native team member name '${MAIN_MEMBER_ID}' is reserved for the root session.`);
  return RESERVED_NAME_FALLBACK;
}

export function normalizeTeamMemberName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(UNSAFE_NAME_CHARS, FANOUT_SUFFIX_SEPARATOR)
    .replace(SURROUNDING_SEPARATORS, '')
    .slice(0, MAX_MEMBER_NAME_LENGTH)
    .replace(SURROUNDING_SEPARATORS, '');
  return normalized || FALLBACK_MEMBER_NAME;
}

function directMemberName(input: NativeTeamChildIntercomInput): string {
  const base = guardReservedName(normalizeTeamMemberName(input.agent), false);
  const suffix = normalizeTeamMemberName(input.runId).slice(0, 8);
  const room = MAX_MEMBER_NAME_LENGTH - suffix.length - FANOUT_SUFFIX_SEPARATOR.length;
  return `${base.slice(0, room).replace(SURROUNDING_SEPARATORS, '') || FALLBACK_MEMBER_NAME}-${suffix}`;
}

function validateTask(task: TeamTaskMetadata | undefined): TeamTaskMetadata | undefined {
  if (!task) return undefined;
  const id = task.id.trim();
  const subject = task.subject.trim();
  if (!id || !subject) throw new Error('Native team task metadata requires an id and subject.');
  return { id, subject };
}

function parseTeamToolParams(raw: unknown): TeamToolParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidRequest('Intercom params must be an object.', 'Use one documented intercom action shape.');
  }
  const params = raw as Record<string, unknown>;
  const action = TEAM_ACTIONS.find((candidate) => candidate === params.action);
  if (!action) {
    throw new DoomTeamExpectedError(
      'unsupported_operation',
      `Unsupported intercom action: ${String(params.action)}.`,
      false,
      'Use members, send, ask, pending, or reply.',
    );
  }
  if (!isOptionalString(params.to) || !isOptionalString(params.message) || !isOptionalString(params.requestId)) {
    throw invalidRequest(
      'Intercom to, message and requestId values must be strings.',
      'Correct the action fields and retry.',
    );
  }
  if (params.timeoutMs !== undefined && (!isInteger(params.timeoutMs) || params.timeoutMs < 1)) {
    throw invalidRequest('Intercom timeoutMs must be a positive integer.', 'Correct timeoutMs and retry.');
  }
  const allowed = new Set(
    action === 'members' || action === 'pending'
      ? ['action']
      : action === 'reply'
        ? ['action', 'requestId', 'message']
        : action === 'ask'
          ? ['action', 'to', 'message', 'timeoutMs']
          : ['action', 'to', 'message'],
  );
  const unknown = Object.keys(params).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw invalidRequest(
      `Intercom action '${action}' does not accept: ${unknown.join(', ')}.`,
      'Remove unknown fields and retry.',
    );
  }
  return {
    action,
    ...(params.to !== undefined ? { to: params.to } : {}),
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
}

function validateMessage(message: string | undefined): string {
  const normalized = message?.trim();
  if (!normalized) {
    throw invalidRequest('message is required for intercom communication.', 'Provide a nonblank message.');
  }
  if (!withinBytes(normalized, MAX_MESSAGE_BYTES)) {
    throw invalidRequest('Intercom message exceeds 64 KiB.', 'Shorten the message and retry.');
  }
  return normalized;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Native team request cancelled.'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('Native team request cancelled.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toChildSessionToolResult(result: AgentToolResult<Record<string, unknown>>): DoomChildSessionToolResult {
  return {
    content: result.content.filter((item): item is { type: 'text'; text: string } => item.type === 'text'),
    details: result.details,
  };
}

function publicMember(context: TeamMemberContext): NativeTeamMemberSnapshot {
  return {
    name: context.memberId,
    role: context.role,
    ...(context.agent ? { agent: context.agent } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.task ? { task: context.task } : {}),
  };
}

function formatDirectMessage(
  from: TeamMemberContext,
  kind: 'send' | 'ask',
  requestId: string,
  message: string,
): string {
  return `${kind === 'ask' ? 'Question' : 'Message'} from ${from.memberId}${from.agent ? ` (${from.agent})` : ''}.\n\n${message}${kind === 'ask' ? `\n\nReply with ${NATIVE_TEAM_TOOL_NAME}({ action: "reply", requestId: "${requestId}", message: "..." }).` : ''}`;
}

interface DirectMember {
  readonly context: TeamMemberContext;
  deliver?: (message: string) => Promise<void>;
}

interface DirectAsk {
  readonly id: string;
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly createdAt: number;
  readonly promise: Promise<string>;
  readonly resolve: (message: string) => void;
  readonly reject: (error: unknown) => void;
}

export interface NativeTeamChildIntercomInput {
  readonly rootSessionId: string;
  readonly agent: string;
  readonly runId: string;
  readonly childIndex?: number;
  readonly task?: TeamTaskMetadata;
}

class NativeTeamDirectChannel {
  private readonly members = new Map<string, DirectMember>();
  private readonly asks = new Map<string, DirectAsk>();
  private readonly delivered = new BoundedKeySet<string>(MAX_IDEMPOTENCY_KEYS);

  private disposed = false;

  constructor(private readonly root: TeamRootContext) {}

  bindMain(context: TeamMemberContext, transport: NativeTeamTransport): void {
    this.members.set(context.memberId, {
      context,
      deliver: async (message) => {
        transport.sendMessage(
          { customType: TEAM_MESSAGE_CUSTOM_TYPE, content: message, display: true },
          { triggerTurn: true, deliverAs: 'steer' },
        );
      },
    });
  }

  bindChild(input: NativeTeamChildIntercomInput): DoomChildSessionIntercom | undefined {
    if (input.rootSessionId !== this.root.rootSessionId || this.disposed) return undefined;
    const memberId = directMemberName(input);
    const context: TeamMemberContext = {
      ...this.root,
      memberId,
      token: newToken(),
      role: 'subagent',
      agent: input.agent,
      runId: input.runId,
      ...(input.childIndex === undefined ? {} : { childIndex: input.childIndex }),
      ...(input.task === undefined ? {} : { task: validateTask(input.task) }),
    };
    if (this.members.has(memberId)) throw new Error(`Native team member '${memberId}' already exists.`);
    this.members.set(memberId, { context });
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.disposeMember(memberId);
    };
    return {
      bindRuntime: (runtime: DoomChildSessionRuntime): DoomChildSessionTool => {
        const member = this.members.get(memberId);
        if (!member || disposed) throw new Error(`Native team member '${memberId}' is no longer active.`);
        member.deliver = (message) => runtime.steer(message);
        return {
          name: NATIVE_TEAM_TOOL_NAME,
          description: 'Communicate with active native agents in this root session.',
          parameters: TeamToolParamsSchema,
          execute: async (operationId, rawParams, signal, onUpdate) => {
            const result = await this.execute(
              memberId,
              operationId,
              rawParams,
              signal,
              onUpdate && ((update) => onUpdate(toChildSessionToolResult(update))),
            );
            return toChildSessionToolResult(result);
          },
        };
      },
      dispose,
    };
  }

  disposeMember(memberId: string): void {
    this.members.delete(memberId);
    for (const [id, ask] of this.asks) {
      if (ask.fromMemberId === memberId || ask.toMemberId === memberId) {
        ask.reject(new Error(`Native team member '${memberId}' became unreachable before replying.`));
        this.asks.delete(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const ask of this.asks.values()) ask.reject(new Error('Native team channel is no longer active.'));
    this.asks.clear();
    this.members.clear();
    this.delivered.clear();
  }

  snapshots(): NativeTeamMemberSnapshot[] {
    return [...this.members.values()].map((member) => publicMember(member.context));
  }

  hasMember(query: string | undefined): boolean {
    return this.findMember(query) !== undefined;
  }

  hasAsk(requestId: string | undefined): boolean {
    return requestId !== undefined && this.asks.has(requestId);
  }

  pending(memberId: string): Array<{ id: string; fromMemberId: string; createdAt: number }> {
    return [...this.asks.values()]
      .filter((ask) => ask.toMemberId === memberId)
      .map(({ id, fromMemberId, createdAt }) => ({ id, fromMemberId, createdAt }))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  async execute(
    memberId: string,
    operationId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<Record<string, unknown>>) => void,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const params = parseTeamToolParams(rawParams);
    const member = this.members.get(memberId);
    if (!member) throw new Error('This native team member is no longer active.');
    if (params.action === 'members') {
      const snapshots = this.snapshots();
      return {
        content: [
          {
            type: 'text',
            text: snapshots.length
              ? snapshots.map((entry) => `- ${entry.name}: ${entry.agent ?? entry.name}`).join('\n')
              : 'No active members.',
          },
        ],
        details: { members: snapshots },
      };
    }
    if (params.action === 'pending') {
      const asks = this.pending(memberId);
      return {
        content: [
          {
            type: 'text',
            text: asks.length
              ? asks
                  .map(
                    (ask) =>
                      `- ${ask.id}: from ${ask.fromMemberId}. Reply with ${NATIVE_TEAM_TOOL_NAME}({ action: "reply", requestId: "${ask.id}", message: "..." }).`,
                  )
                  .join('\n')
              : 'No pending native team asks.',
          },
        ],
        details: { pending: asks.map((ask) => ({ id: ask.id, from: ask.fromMemberId })) },
      };
    }

    const message = validateMessage(params.message);
    if (params.action === 'reply') {
      const request = this.asks.get(params.requestId ?? '');
      if (!request || request.toMemberId !== memberId) {
        throw new DoomTeamExpectedError(
          'recipient_not_found',
          `No pending intercom ask matches requestId '${params.requestId}'.`,
          false,
          'Call intercom({"action":"pending"}) and retry with an exact requestId.',
        );
      }
      request.resolve(message);
      this.asks.delete(request.id);
      return {
        content: [{ type: 'text', text: `Replied to native team request ${request.id}.` }],
        details: { requestId: request.id, to: request.fromMemberId },
      };
    }

    const target = this.findMember(params.to);
    if (!target) {
      throw new DoomTeamExpectedError(
        'recipient_not_found',
        `Active intercom member '${params.to}' was not found.`,
        true,
        'Call intercom({"action":"members"}) and retry with an active member id.',
      );
    }
    const messageId = operationMessageId(memberId, operationId);
    if (params.action === 'send') {
      if (this.delivered.has(messageId)) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} delivered to ${target.context.memberId}.` }],
          details: { state: 'delivered', delivered: true, messageId, to: target.context.memberId },
        };
      }
      await this.deliver(target, formatDirectMessage(member.context, 'send', messageId, message));
      this.delivered.add(messageId);
      return {
        content: [{ type: 'text', text: `Message ${messageId} delivered to ${target.context.memberId}.` }],
        details: { state: 'delivered', delivered: true, messageId, to: target.context.memberId },
      };
    }

    let ask = this.asks.get(messageId);
    let delivered = false;
    if (!ask) {
      ask = this.createAsk(memberId, target.context.memberId, messageId);
      delivered = true;
    }
    onUpdate?.({
      content: [{ type: 'text', text: `Waiting for ${target.context.memberId} to reply...` }],
      details: { action: 'ask', to: target.context.memberId, partial: true },
    });
    try {
      if (delivered) {
        await this.deliver(target, formatDirectMessage(member.context, 'ask', ask.id, message));
        signal?.throwIfAborted();
      }
      const reply = await Promise.race([
        ask.promise,
        delay(params.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS, signal).then(() => {
          throw new DoomTeamExpectedError(
            'reply_timeout',
            `Timed out waiting for intercom member '${target.context.memberId}' to reply.`,
            true,
            'Check member status before deciding whether to ask again.',
          );
        }),
      ]);
      return {
        content: [{ type: 'text', text: `Reply from ${target.context.memberId}:\n${reply}` }],
        details: { requestId: ask.id, from: target.context.memberId, reply },
      };
    } finally {
      this.asks.delete(ask.id);
    }
  }

  private createAsk(fromMemberId: string, toMemberId: string, id: string): DirectAsk {
    let resolve!: (value: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    void promise.catch(() => undefined);
    const ask: DirectAsk = { id, fromMemberId, toMemberId, createdAt: Date.now(), promise, resolve, reject };
    this.asks.set(id, ask);
    return ask;
  }

  private findMember(query: string | undefined): DirectMember | undefined {
    if (!query) return undefined;
    const lowered = query.toLowerCase();
    const normalized = normalizeTeamMemberName(query);
    return [...this.members.values()].find(
      (member) =>
        member.context.memberId === query ||
        member.context.memberId === normalized ||
        member.context.agent?.toLowerCase() === lowered ||
        member.context.runId?.toLowerCase() === lowered,
    );
  }

  private async deliver(target: DirectMember, message: string): Promise<void> {
    if (!target.deliver) {
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        `Intercom member '${target.context.memberId}' is not ready.`,
        true,
        'Retry after the child session starts.',
      );
    }
    await target.deliver(message);
  }
}

export interface NativeTeamTransport {
  sendMessage: ExtensionAPI['sendMessage'];
  sendUserMessage: ExtensionAPI['sendUserMessage'];
}

export interface NativeTeamRuntime {
  bindMainSession(rootSessionId: string): TeamMemberContext;
  current(): TeamMemberContext | undefined;
  snapshot(): NativeTeamSnapshot;
  execute(
    operationId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<Record<string, unknown>>) => void,
  ): Promise<AgentToolResult<Record<string, unknown>>>;
  undeliverable(): readonly never[];
  dispose(): void;
}

class TeamChannelRuntime implements NativeTeamRuntime {
  private context: TeamMemberContext | undefined;
  private directChannel: NativeTeamDirectChannel | undefined;

  constructor(
    private readonly transport: NativeTeamTransport,
    private readonly directChannelForRoot: (rootSessionId: string) => NativeTeamDirectChannel,
  ) {}

  current(): TeamMemberContext | undefined {
    return this.context;
  }

  snapshot(): NativeTeamSnapshot {
    return { members: this.directChannel?.snapshots() ?? [] };
  }

  undeliverable(): readonly never[] {
    return [];
  }

  execute(
    operationId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<Record<string, unknown>>) => void,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const context = this.context;
    if (!context || !this.directChannel) {
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        'Intercom is not active for this session.',
        true,
        'Wait for session startup or reload Doom Team.',
      );
    }
    return this.directChannel.execute(context.memberId, operationId, rawParams, signal, onUpdate);
  }

  bindMainSession(rootSessionId: string): TeamMemberContext {
    const root = ensureNativeTeamRoot(rootSessionId);
    this.directChannel = this.directChannelForRoot(root.rootSessionId);
    this.context = {
      ...root,
      memberId: root.mainMemberId,
      token: newToken(),
      role: 'main',
    };
    this.directChannel.bindMain(this.context, this.transport);
    return this.context;
  }

  dispose(): void {
    this.directChannel?.dispose();
    this.directChannel = undefined;
    this.context = undefined;
  }
}

export type NativeTeamChannelContract = {
  createRuntime(pi: ExtensionAPI): NativeTeamRuntime;
  createHeadlessRuntime(transport: NativeTeamTransport): NativeTeamRuntime;
  createNativeChildIntercom(input: NativeTeamChildIntercomInput): DoomChildSessionIntercom | undefined;
};

export function ensureNativeTeamRoot(rootSessionId: string): TeamRootContext {
  const normalizedSessionId = rootSessionId.trim();
  if (!normalizedSessionId) throw new Error('A root session id is required for native team communication.');
  return {
    version: TEAM_ROOT_VERSION,
    teamId: teamIdForSession(normalizedSessionId),
    rootSessionId: normalizedSessionId,
    mainMemberId: MAIN_MEMBER_ID,
  };
}

export class NativeTeamChannelService implements NativeTeamChannelContract {
  private readonly runtimes = new WeakMap<ExtensionAPI, NativeTeamRuntime>();
  private readonly directChannels = new Map<string, NativeTeamDirectChannel>();

  private directChannelForRoot(rootSessionId: string): NativeTeamDirectChannel {
    const existing = this.directChannels.get(rootSessionId);
    if (existing) return existing;
    const channel = new NativeTeamDirectChannel(ensureNativeTeamRoot(rootSessionId));
    this.directChannels.set(rootSessionId, channel);
    return channel;
  }

  createNativeChildIntercom(input: NativeTeamChildIntercomInput): DoomChildSessionIntercom | undefined {
    return this.directChannels.get(input.rootSessionId)?.bindChild(input);
  }

  createRuntime(pi: ExtensionAPI): NativeTeamRuntime {
    const existing = this.runtimes.get(pi);
    if (existing) return existing;
    const runtime = new TeamChannelRuntime(pi, (rootSessionId) => this.directChannelForRoot(rootSessionId));
    this.runtimes.set(pi, runtime);
    return runtime;
  }

  createHeadlessRuntime(transport: NativeTeamTransport): NativeTeamRuntime {
    return new TeamChannelRuntime(transport, (rootSessionId) => this.directChannelForRoot(rootSessionId));
  }
}
