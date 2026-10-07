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
} from '@agimon-ai/doompi-core/childSession';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TEAM_ACTIONS, TeamToolParamsSchema } from '../../schemas/team/intercom';
import { BoundedKeySet } from '../boundedKeySet';
import { DoomTeamExpectedError, invalidRequest } from '../errors';

export { TeamToolParamsSchema } from '../../schemas/team/intercom';

/** Wire literal. The model calls the tool by this name, so it is not renamed. */
export const NATIVE_TEAM_TOOL_NAME = 'intercom';

export const TEAM_MESSAGE_CUSTOM_TYPE = 'intercom_message';
const MAIN_MEMBER_ID = 'main';
const RESERVED_NAME_FALLBACK = 'main-agent';
const FALLBACK_MEMBER_NAME = 'agent';
const MAX_MEMBER_NAME_LENGTH = 48;
const FANOUT_SUFFIX_SEPARATOR = '-';
const MAX_MESSAGE_BYTES = 64 * 1024;
/** An unanswered ask wakes its asker once, after this long. */
const ASK_WAKE_MS = 3 * 60 * 1000;
const MAX_IDEMPOTENCY_KEYS = 1024;
const HASH_ALGORITHM = 'sha256';
const TOKEN_BYTES = 32;
const TEAM_ID_PREFIX = 'session-';
const TEAM_ROOT_VERSION = 1;

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
  inline?: boolean;
  runId?: string;
  childIndex?: number;
  parentMemberId?: string;
  task?: TeamTaskMetadata;
}

export interface NativeTeamMemberSnapshot {
  name: string;
  role: TeamMemberRole;
  agent?: string;
  /** True when this run came from a one-shot inline agent definition. */
  inline?: boolean;
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

/**
 * The member id, which is also the address a peer sends to.
 *
 * A generated identity (`alan-reviewer-3`) already survives
 * `normalizeTeamMemberName` unchanged and is unique per session, so it is used
 * verbatim. The older `<agent>-<runId prefix>` shape remains the fallback for a
 * run whose identity could not be claimed, so a spawn never fails for want of
 * a name.
 */
function directMemberName(input: NativeTeamChildIntercomInput): string {
  if (input.identity?.trim()) return guardReservedName(normalizeTeamMemberName(input.identity), false);
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

export function parseTeamToolParams(raw: unknown): TeamToolParams {
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
  const allowed = new Set(
    action === 'members' || action === 'pending'
      ? ['action']
      : action === 'reply'
        ? ['action', 'requestId', 'message']
        : ['action', 'to', 'message'],
  );
  const unknown = Object.keys(params).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw invalidRequest(
      `Intercom action '${action}' does not accept: ${unknown.join(', ')}.`,
      'Remove unknown fields and retry.',
    );
  }
  if ((action === 'send' || action === 'ask') && !params.to?.trim()) {
    throw invalidRequest(`Intercom action '${action}' requires to.`, 'Pass the member id to address and retry.');
  }
  if (action === 'reply' && !params.requestId?.trim()) {
    throw invalidRequest(
      "Intercom action 'reply' requires requestId.",
      'Pass the requestId from the question and retry.',
    );
  }
  return {
    action,
    ...(params.to !== undefined ? { to: params.to } : {}),
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
  };
}

export function validateMessage(message: string | undefined): string {
  const normalized = message?.trim();
  if (!normalized) {
    throw invalidRequest('message is required for intercom communication.', 'Provide a nonblank message.');
  }
  if (!withinBytes(normalized, MAX_MESSAGE_BYTES)) {
    throw invalidRequest('Intercom message exceeds 64 KiB.', 'Shorten the message and retry.');
  }
  return normalized;
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
    ...(context.inline ? { inline: true } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.task ? { task: context.task } : {}),
  };
}

export interface IntercomMessageDetails {
  readonly kind: 'send' | 'ask' | 'reply' | 'no_reply';
  readonly from: NativeTeamMemberSnapshot;
  readonly message: string;
  readonly requestId: string;
}

interface DirectMessage {
  readonly content: string;
  readonly details: IntercomMessageDetails;
}

function formatDirectMessage(
  from: TeamMemberContext,
  kind: IntercomMessageDetails['kind'],
  requestId: string,
  message: string,
): DirectMessage {
  const who = `${from.memberId}${from.inline ? ' (inline)' : ''}${from.agent ? ` [${from.agent}]` : ''}`;
  const content =
    kind === 'reply'
      ? `Reply from ${who} to your question ${requestId}.\n\n${message}`
      : kind === 'no_reply'
        ? `No reply from ${who} to your question ${requestId}. ${message}`
        : `${kind === 'ask' ? 'Question' : 'Message'} from ${who}.\n\n${message}${kind === 'ask' ? `\n\nReply with ${NATIVE_TEAM_TOOL_NAME}({ action: "reply", requestId: "${requestId}", message: "..." }).` : ''}`;
  return { content, details: { kind, from: publicMember(from), message, requestId } };
}

interface DirectMember {
  readonly context: TeamMemberContext;
  deliver?: (message: DirectMessage) => Promise<void>;
  /** Deliveries whose admission has not settled yet. */
  inFlight: number;
  /** Something was admitted since the last `hold` check, so a turn may be starting. */
  delivered: boolean;
  /** Resolves a parked `hold`: true to drain and check again, false to let the run finish. */
  release?: (more: boolean) => void;
}

interface DirectAsk {
  readonly id: string;
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly createdAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The single no-reply reminder fired. The ask stays open but no longer holds the asker. */
  woken: boolean;
}

export interface NativeTeamChildIntercomInput {
  readonly rootSessionId: string;
  readonly agent: string;
  /** Generated addressable identity. Absent only when its claim could not be written. */
  readonly identity?: string;
  readonly inline?: boolean;
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
      inFlight: 0,
      delivered: false,
      deliver: async (message) => {
        await transport.sendMessage(
          {
            customType: TEAM_MESSAGE_CUSTOM_TYPE,
            content: message.content,
            display: true,
            details: message.details,
          },
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
      ...(input.inline ? { inline: true } : {}),
      runId: input.runId,
      ...(input.childIndex === undefined ? {} : { childIndex: input.childIndex }),
      ...(input.task === undefined ? {} : { task: validateTask(input.task) }),
    };
    if (this.members.has(memberId)) throw new Error(`Native team member '${memberId}' already exists.`);
    this.members.set(memberId, { context, inFlight: 0, delivered: false });
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
        member.deliver = (message) => runtime.steer(message.content);
        return {
          name: NATIVE_TEAM_TOOL_NAME,
          description: 'Communicate with active native agents in this root session.',
          parameters: TeamToolParamsSchema,
          execute: async (operationId, rawParams) =>
            toChildSessionToolResult(await this.execute(memberId, operationId, rawParams)),
        };
      },
      dispose,
      hold: () => this.hold(memberId),
    };
  }

  /**
   * Keeps a child run open while intercom still owes it something. Checked after
   * each child turn settles. Holding means: a delivery to it is in flight, or it
   * has an ask with neither a reply nor the reminder yet. Otherwise the member is
   * removed in this same synchronous call, so nothing can be admitted into a
   * runtime that is about to be disposed.
   */
  private hold(memberId: string): Promise<boolean> {
    const member = this.members.get(memberId);
    if (!member) return Promise.resolve(false);
    if (member.delivered) {
      member.delivered = false;
      return Promise.resolve(true);
    }
    const waiting =
      member.inFlight > 0 || [...this.asks.values()].some((ask) => ask.fromMemberId === memberId && !ask.woken);
    if (!waiting) {
      this.disposeMember(memberId);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      member.release = (more) => {
        member.release = undefined;
        resolve(more);
      };
    });
  }

  disposeMember(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    this.members.delete(memberId);
    for (const ask of this.asks.values()) {
      if (ask.fromMemberId === memberId) this.closeAsk(ask);
      else if (ask.toMemberId === memberId) {
        this.closeAsk(ask);
        this.notifyAsker(ask, member.context, 'It finished without replying.');
      }
    }
    member.release?.(false);
  }

  dispose(): void {
    this.disposed = true;
    for (const ask of this.asks.values()) clearTimeout(ask.timer);
    this.asks.clear();
    const members = [...this.members.values()];
    this.members.clear();
    this.delivered.clear();
    for (const member of members) member.release?.(false);
  }

  snapshots(): NativeTeamMemberSnapshot[] {
    return [...this.members.values()].map((member) => publicMember(member.context));
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
              ? snapshots
                  .map((entry) => `- ${entry.name}${entry.inline ? ' (inline)' : ''}: ${entry.agent ?? entry.name}`)
                  .join('\n')
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
      const asker = request && this.members.get(request.fromMemberId);
      if (!request || request.toMemberId !== memberId || !asker) {
        throw new DoomTeamExpectedError(
          'recipient_not_found',
          `No open intercom ask matches requestId '${params.requestId}'. It may already be answered, or its asker has finished.`,
          false,
          'Call intercom({"action":"pending"}) and retry with an exact requestId, or continue without replying.',
        );
      }
      // On failure the ask stays open so the reply can be retried.
      await this.deliver(asker, formatDirectMessage(member.context, 'reply', request.id, message));
      this.closeAsk(request);
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
    const isAsk = params.action === 'ask';
    const result = (): AgentToolResult<Record<string, unknown>> => ({
      content: [
        {
          type: 'text',
          text: isAsk
            ? `Question ${messageId} delivered to ${target.context.memberId}. The reply will arrive later as a message; keep working.`
            : `Message ${messageId} delivered to ${target.context.memberId}.`,
        },
      ],
      details: {
        state: 'delivered',
        delivered: true,
        messageId,
        to: target.context.memberId,
        ...(isAsk ? { requestId: messageId } : {}),
      },
    });
    // A retried tool call returns the first outcome instead of delivering twice.
    if (this.delivered.has(messageId) || this.asks.has(messageId)) return result();
    const ask = isAsk ? this.openAsk(memberId, target.context.memberId, messageId) : undefined;
    try {
      await this.deliver(target, formatDirectMessage(member.context, params.action, messageId, message));
    } catch (error) {
      if (ask) this.closeAsk(ask);
      throw error;
    }
    this.delivered.add(messageId);
    return result();
  }

  /** Stored before delivery so a reply that races the delivery still finds it. */
  private openAsk(fromMemberId: string, toMemberId: string, id: string): DirectAsk {
    const timer = setTimeout(() => this.wake(id), ASK_WAKE_MS);
    timer.unref?.();
    const ask: DirectAsk = { id, fromMemberId, toMemberId, createdAt: Date.now(), timer, woken: false };
    this.asks.set(id, ask);
    return ask;
  }

  private closeAsk(ask: DirectAsk): void {
    clearTimeout(ask.timer);
    this.asks.delete(ask.id);
    this.members.get(ask.fromMemberId)?.release?.(true);
  }

  /** The single reminder. The ask stays open; the asker decides what to do next. */
  private wake(id: string): void {
    const ask = this.asks.get(id);
    if (!ask || ask.woken) return;
    ask.woken = true;
    const target = this.members.get(ask.toMemberId);
    if (target) {
      this.notifyAsker(
        ask,
        target.context,
        'It has been 3 minutes. The question stays open and a late reply will still arrive while you are running. It is your call: keep working, ask again, or finish.',
      );
    }
    this.members.get(ask.fromMemberId)?.release?.(true);
  }

  /** Best effort: the asker may be gone, and a lost notice must not fail the caller. */
  private notifyAsker(ask: DirectAsk, about: TeamMemberContext, notice: string): void {
    const asker = this.members.get(ask.fromMemberId);
    if (!asker) return;
    void this.deliver(asker, formatDirectMessage(about, 'no_reply', ask.id, notice)).catch(() => undefined);
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

  private async deliver(target: DirectMember, message: DirectMessage): Promise<void> {
    const id = target.context.memberId;
    if (this.members.get(id) !== target) {
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        `Intercom member '${id}' has finished.`,
        false,
        'Call intercom({"action":"members"}) to see who is active.',
      );
    }
    if (!target.deliver) {
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        `Intercom member '${id}' is not ready.`,
        true,
        'Retry after the child session starts.',
      );
    }
    target.inFlight += 1;
    try {
      await target.deliver(message);
      target.delivered = true;
    } catch (error) {
      if (error instanceof DoomTeamExpectedError) throw error;
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        `Intercom member '${id}' could not receive the message: ${error instanceof Error ? error.message : String(error)}`,
        true,
        'Retry shortly, or continue without it.',
      );
    } finally {
      target.inFlight -= 1;
      target.release?.(true);
    }
  }
}

export interface NativeTeamTransport {
  /** Resolves once the message is admitted, so a failed hand-off reaches the sender. */
  sendMessage: (...args: Parameters<ExtensionAPI['sendMessage']>) => void | Promise<void>;
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

  execute(operationId: string, rawParams: unknown): Promise<AgentToolResult<Record<string, unknown>>> {
    const context = this.context;
    if (!context || !this.directChannel) {
      throw new DoomTeamExpectedError(
        'communication_unavailable',
        'Intercom is not active for this session.',
        true,
        'Wait for session startup or reload Doom Team.',
      );
    }
    return this.directChannel.execute(context.memberId, operationId, rawParams);
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
