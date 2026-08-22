/**
 * Peer messaging between the named members of one root session's team.
 *
 * A team is every agent process descended from a single root session. Each
 * member owns an inbox directory; peers drop message files into it and the
 * member's poll loop delivers them into its own agent turn. `ask` blocks the
 * sender until the recipient writes a reply file.
 *
 * DESIGN PATTERNS:
 * - A member's name IS its id. Names are what an operator and a model both use
 *   to address a teammate, so a second opaque identifier would only ever be a
 *   translation layer that can drift
 * - Deliver, then mark seen. Delivery is the side effect that must not be lost,
 *   so nothing is recorded as handled until the transport has accepted it
 * - Every record on disk carries a version through `parseVersioned`, so a
 *   process running an older build skips a record it cannot read rather than
 *   misreading it
 * - One writer per file. A member writes only its own member record, its own
 *   heartbeat and other members' inboxes. No file is read-modify-written by two
 *   processes, so no update can be lost
 *
 * PERFORMANCE:
 * - The poll skips a file by name before opening it, so an inbox that has
 *   accumulated files that are not for us costs one readdir per poll rather than
 *   one parse per file per poll
 * - Dead members' directories are swept on a timer, which is what stops that
 *   readdir from growing for the life of a long session
 *
 * SEVEN FAILURE MODES THIS MODULE IS BUILT AROUND. Each is called out again at
 * the code that handles it, because each one is a plausible "simplification"
 * that would silently reintroduce message loss:
 * 1. Marking a message seen before delivering it loses it permanently when the
 *    transport throws, because a seen message is never retried.
 * 2. Ordering by wall-clock alone reorders two messages from the same sender
 *    written in the same millisecond.
 * 3. Leaving a file that is not addressed to us unseen re-parses it on every
 *    poll, forever.
 * 4. Putting the sender's token in the envelope hands every recipient the value
 *    it needs to impersonate that sender.
 * 5. An unbounded seen set grows for the life of the session.
 * 6. Read-modify-writing a shared heartbeat file lets a stale writer resurrect
 *    a dead member.
 * 7. Never collecting dead members leaves their inboxes and records on disk.
 *
 * AVOID:
 * - Any module-level mutable state; the runtime owns everything stateful so a
 *   second session in the same process cannot inherit the first one's inbox
 * - Deleting a file that failed validation because of a team mismatch; that file
 *   belongs to another session and is not ours to destroy
 * - Treating an atomic write as a lock. It prevents a torn read, nothing else
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import {
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
} from '../../types/environment';
import { writePrivateAtomicJson } from '../atomicJson';
import { BoundedKeySet } from '../../services/support/boundedKeySet';
import { DoomTeamExpectedError, invalidRequest } from '../../services/support/errors';
import { LruCache } from '../../services/support/lruCache';
import { requireCurrentSessionScope, scopeTeamDir, tryCurrentSessionScope } from '../filesystem/paths';
import { parseVersioned } from '../../services/support/versioned';

/** Wire literal. The model calls the tool by this name, so it is not renamed. */
export const NATIVE_TEAM_TOOL_NAME = 'intercom';

/** Wire literals. Present in every envelope so a foreign file is recognisable. */
const TEAM_MESSAGE_TYPE = 'subagent.team.message';
const TEAM_REPLY_TYPE = 'subagent.team.reply';
/** Custom message types the host renders. */
const TEAM_MESSAGE_CUSTOM_TYPE = 'intercom_message';
const TEAM_UNDELIVERABLE_CUSTOM_TYPE = 'intercom_undeliverable';

const MEMBERS_DIR = 'members';
const HEARTBEATS_DIR = 'heartbeats';
const INBOXES_DIR = 'inboxes';
const REPLIES_DIR = 'replies';
const RECEIPTS_DIR = 'receipts';
const TEAM_FILE = 'team.json';
const JSON_FILE_SUFFIX = '.json';

/** Reserved for the root session. A child that asks for it is refused. */
const MAIN_MEMBER_ID = 'main';
/** Substituted when a derived name would land on the reserved root name. */
const RESERVED_NAME_FALLBACK = 'main-agent';
const FALLBACK_MEMBER_NAME = 'agent';
const MAX_MEMBER_NAME_LENGTH = 48;
const FANOUT_SUFFIX_SEPARATOR = '-';
/** Fanout suffixes are 1-based, so the first child of a fanout reads as `-1`. */
const FIRST_FANOUT_ORDINAL = 1;

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TASK_ID_BYTES = 256;
const MAX_TASK_SUBJECT_BYTES = 4 * 1024;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Exported: `task-board.ts` gates a claim guard on the same staleness window,
 * and must never drift from it. Two definitions of "how stale is too stale"
 * would let a claim guard and this module's own liveness check disagree about
 * who is alive.
 */
export const HEARTBEAT_STALE_MS = 30_000;
const CHANNEL_POLL_MS = 250;
const REPLY_POLL_MS = 250;

/**
 * How many times one message may fail delivery before it is given up on.
 *
 * The retry exists for a transient host refusal, and the bound exists because a
 * message the host will never accept would otherwise be re-delivered on every
 * poll for the life of the session, starving every message behind it.
 */
const MAX_DELIVERY_ATTEMPTS = 5;
const FIRST_DELIVERY_ATTEMPT = 1;
/** Comfortably above the number of inbox files that can be live at once. */
const SEEN_FILE_CAPACITY = 1024;
const DELIVERY_ATTEMPT_CAPACITY = 256;
const UNDELIVERABLE_HISTORY_LIMIT = 32;

const TEAM_GC_INTERVAL_MS = 60_000;
/**
 * How long past its liveness deadline a member's state is kept.
 *
 * Deliberately much larger than `HEARTBEAT_STALE_MS`: a member that is merely
 * slow to start, or stopped at a breakpoint, must not have its inbox deleted
 * out from under a peer that is mid-`ask`.
 */
const TEAM_GC_GRACE_MS = 5 * 60 * 1000;

const TEAM_ROOT_VERSION = 1;
const MEMBER_RECORD_VERSION = 1;
const HEARTBEAT_RECORD_VERSION = 1;
/**
 * Version 2 of the envelope. Version 1 carried the sender's token and had no
 * sequence number; both are load-bearing changes, so an old envelope is
 * rejected rather than read with the missing fields defaulted.
 */
const ENVELOPE_VERSION = 2;

const TEAM_ACTIONS = ['members', 'send', 'ask', 'reply', 'pending'] as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const UNSAFE_NAME_CHARS = /[^a-z0-9._-]+/g;
const SURROUNDING_SEPARATORS = /^[-.]+|[-.]+$/g;
const TEAM_ID_HASH_LENGTH = 32;
const TOKEN_BYTES = 32;
const HASH_ALGORITHM = 'sha256';
const RECEIPT_VERSION = 1;
const RECEIPT_DELIVERED = 'delivered';
const RECEIPT_FAILED = 'failed';
const TEAM_ID_PREFIX = 'session-';

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
  token: string;
  role: TeamMemberRole;
  agent?: string;
  runId?: string;
  childIndex?: number;
  parentMemberId?: string;
  task?: TeamTaskMetadata;
}

interface TeamRecord extends TeamRootContext {
  createdAt: number;
  updatedAt: number;
}

/**
 * The member's durable identity.
 *
 * FIX 6: no `heartbeatAt`. Liveness moved to a per-member file so that writing a
 * heartbeat never rewrites identity, and so a writer can only ever affect its
 * own liveness.
 */
export interface TeamMemberRecord extends Omit<TeamMemberContext, 'token' | 'version'> {
  version: typeof MEMBER_RECORD_VERSION;
  tokenHash: string;
  pid: number;
  active: boolean;
  joinedAt: number;
  leftAt?: number;
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

/**
 * One member's liveness, in a file only that member writes.
 *
 * FIX 6: the predecessor kept `heartbeatAt` inside the member record and
 * refreshed it with a read-modify-write. Two writers racing that read could
 * republish a stale snapshot, which resurrected a member that had already
 * marked itself inactive. `tokenHash` is repeated here so a heartbeat left
 * behind by a previous owner of the same name does not count for the new one.
 */
export interface TeamHeartbeatRecord {
  version: typeof HEARTBEAT_RECORD_VERSION;
  memberId: string;
  tokenHash: string;
  pid: number;
  heartbeatAt: number;
}

type TeamMessageKind = 'send' | 'ask';

/**
 * FIX 4: `senderTokenHash`, never the token itself.
 *
 * The predecessor embedded the sender's bearer token, so every recipient came
 * out of a single message holding the value that authenticates that sender to
 * `assertCurrentMember`, to `dispose`, and to any future capability keyed on it.
 * A hash is enough for the recipient's actual question, which is only "does this
 * match the tokenHash in the sender's member record". What it deliberately does
 * NOT claim is unforgeability against a process that can already write into this
 * team directory: everyone in the team runs as the same OS user, so the
 * boundary here is the token, not the directory.
 */
interface TeamMessageEnvelope {
  type: typeof TEAM_MESSAGE_TYPE;
  version: typeof ENVELOPE_VERSION;
  id: string;
  teamId: string;
  kind: TeamMessageKind;
  fromMemberId: string;
  toMemberId: string;
  senderTokenHash: string;
  /**
   * FIX 2: monotonic per sender, assigned in the order the sender queued.
   *
   * `createdAt` has millisecond resolution, so two messages from one sender in
   * the same millisecond are indistinguishable by time and were delivered in
   * whatever order the directory happened to list them.
   */
  seq: number;
  message: string;
  createdAt: number;
  expiresAt: number;
}

interface TeamReplyEnvelope {
  type: typeof TEAM_REPLY_TYPE;
  version: typeof ENVELOPE_VERSION;
  requestId: string;
  teamId: string;
  fromMemberId: string;
  toMemberId: string;
  senderTokenHash: string;
  message: string;
  createdAt: number;
}

/** A message the transport refused often enough that it was given up on. */
export interface UndeliverableTeamMessage {
  messageId: string;
  fromMemberId: string;
  kind: TeamMessageKind;
  attempts: number;
  reason: string;
  at: number;
}

interface TeamToolParams {
  action: (typeof TEAM_ACTIONS)[number];
  to?: string;
  message?: string;
  requestId?: string;
  timeoutMs?: number;
}

/**
 * Hand-written JSON Schema rather than a TypeBox builder, so the wire shape is
 * readable in one place. The cast is the reason `execute` narrows its params
 * with a real guard instead of trusting the static type.
 */
const TeamToolParamsSchema = {
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

// ---------------------------------------------------------------------------
// Narrowing helpers. Everything read off disk or out of a tool call arrives as
// `unknown` and is narrowed by one of these; nothing is asserted into shape.
// ---------------------------------------------------------------------------

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || isInteger(value);
}

function isMemberRole(value: unknown): value is TeamMemberRole {
  return value === 'main' || value === 'subagent';
}

function isMessageKind(value: unknown): value is TeamMessageKind {
  return value === 'send' || value === 'ask';
}

function withinBytes(value: string, limit: number): boolean {
  return Buffer.byteLength(value, 'utf-8') <= limit;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hash(value: string): string {
  return createHash(HASH_ALGORITHM).update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function teamIdForSession(rootSessionId: string): string {
  return `${TEAM_ID_PREFIX}${hash(rootSessionId).slice(0, TEAM_ID_HASH_LENGTH)}`;
}

// ---------------------------------------------------------------------------
// Member names. A name is the id, so naming rules are identity rules.
// ---------------------------------------------------------------------------

/**
 * Reduce any label to a usable member name.
 *
 * Lowercase because a name is typed by hand and by a model, and two members
 * differing only in case would be two identities that read as one.
 */
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

/** Append `-1`..`-N` while keeping the whole name inside the length budget. */
function withFanoutOrdinal(base: string, fanoutIndex: number): string {
  const suffix = `${FANOUT_SUFFIX_SEPARATOR}${fanoutIndex + FIRST_FANOUT_ORDINAL}`;
  const room = MAX_MEMBER_NAME_LENGTH - suffix.length;
  const trimmed = base.slice(0, Math.max(room, 0)).replace(SURROUNDING_SEPARATORS, '');
  return `${trimmed || FALLBACK_MEMBER_NAME}${suffix}`;
}

/**
 * `main` belongs to the root session and to nothing else.
 *
 * An explicit request for it is an error, because silently handing the caller a
 * different name would leave it addressing a member that does not exist. A name
 * that merely derived to `main` is substituted instead, since the caller never
 * asked for that name and cannot act on the refusal.
 */
function guardReservedName(name: string, explicit: boolean): string {
  if (name !== MAIN_MEMBER_ID) return name;
  if (explicit) throw new Error(`Native team member name '${MAIN_MEMBER_ID}' is reserved for the root session.`);
  return RESERVED_NAME_FALLBACK;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * This team's directory, under the owning session's scope.
 *
 * A team is every agent descended from one root session, so the team tree
 * belongs inside that session's scope rather than in a parallel
 * `team-channels/` root shared by every concurrent session. The `teamId`
 * segment is kept even though a scope holds exactly one team: it is the value
 * every record on disk is validated against (see `readNativeTeamRootFromEnvironment`),
 * so keeping path and record agreeing costs one segment and removes a way for
 * a stale tree to be read as the current one.
 */
export function teamDir(teamId: string): string {
  if (!isSafeId(teamId)) throw new Error('Invalid native team id.');
  return path.join(scopeTeamDir(requireCurrentSessionScope()), teamId);
}

function memberPath(root: TeamRootContext, memberId: string): string {
  if (!isSafeId(memberId)) throw new Error('Invalid native team member id.');
  return path.join(teamDir(root.teamId), MEMBERS_DIR, `${memberId}${JSON_FILE_SUFFIX}`);
}

function heartbeatPath(root: TeamRootContext, memberId: string): string {
  if (!isSafeId(memberId)) throw new Error('Invalid native team member id.');
  return path.join(teamDir(root.teamId), HEARTBEATS_DIR, `${memberId}${JSON_FILE_SUFFIX}`);
}

function inboxDir(root: TeamRootContext, memberId: string): string {
  if (!isSafeId(memberId)) throw new Error('Invalid native team member id.');
  return path.join(teamDir(root.teamId), INBOXES_DIR, memberId);
}

function messageFileName(messageId: string): string {
  return `${messageId}${JSON_FILE_SUFFIX}`;
}

function messagePath(root: TeamRootContext, memberId: string, messageId: string): string {
  if (!isSafeId(messageId)) throw new Error('Invalid native team message id.');
  return path.join(inboxDir(root, memberId), messageFileName(messageId));
}

function replyPath(root: TeamRootContext, requestId: string): string {
  if (!isSafeId(requestId)) throw new Error('Invalid native team request id.');
  return path.join(teamDir(root.teamId), REPLIES_DIR, `${requestId}${JSON_FILE_SUFFIX}`);
}

function receiptPath(root: TeamRootContext, senderId: string, messageId: string): string {
  if (!isSafeId(senderId) || !isSafeId(messageId)) throw new Error('Invalid intercom receipt identity.');
  return path.join(teamDir(root.teamId), RECEIPTS_DIR, senderId, `${messageId}${JSON_FILE_SUFFIX}`);
}

function operationMessageId(memberId: string, operationId: string): string {
  return createHash(HASH_ALGORITHM).update(`${memberId}:${operationId}`).digest('hex');
}

function ensureTeamDirectories(root: TeamRootContext): void {
  const rootDir = teamDir(root.teamId);
  for (const child of [MEMBERS_DIR, HEARTBEATS_DIR, INBOXES_DIR, REPLIES_DIR, RECEIPTS_DIR]) {
    fs.mkdirSync(path.join(rootDir, child), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A missing, half-written or corrupt file is a normal state for a directory
    // several processes write to. The caller treats undefined as "not readable
    // yet" and either retries on the next poll or removes the file.
    return undefined;
  }
}

function removeFile(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (error) {
    // Already gone counts as removed. Anything else is reported so a caller
    // that must not re-deliver can tell the difference.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function removeDirectory(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    // Best effort. A directory that resists removal is retried by the next
    // sweep; failing the sweep would stop the rest of the cleanup.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

function parseTeamRecord(value: Record<string, unknown> | undefined): TeamRecord | undefined {
  const versioned = parseVersioned(value, [TEAM_ROOT_VERSION]);
  if (!versioned.ok || !value) return undefined;
  if (
    !isSafeId(value.teamId) ||
    !isNonEmptyString(value.rootSessionId) ||
    value.mainMemberId !== MAIN_MEMBER_ID ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  )
    return undefined;
  return {
    version: TEAM_ROOT_VERSION,
    teamId: value.teamId,
    rootSessionId: value.rootSessionId,
    mainMemberId: MAIN_MEMBER_ID,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseTaskMetadata(value: unknown): TeamTaskMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const task: Record<string, unknown> = value as Record<string, unknown>;
  if (!isNonEmptyString(task.id) || !isNonEmptyString(task.subject)) return undefined;
  if (!withinBytes(task.id, MAX_TASK_ID_BYTES) || !withinBytes(task.subject, MAX_TASK_SUBJECT_BYTES)) return undefined;
  return { id: task.id, subject: task.subject };
}

function parseMemberRecord(value: Record<string, unknown> | undefined): TeamMemberRecord | undefined {
  const versioned = parseVersioned(value, [MEMBER_RECORD_VERSION]);
  if (!versioned.ok || !value) return undefined;
  if (
    !isSafeId(value.teamId) ||
    !isNonEmptyString(value.rootSessionId) ||
    !isNonEmptyString(value.mainMemberId) ||
    !isSafeId(value.memberId) ||
    !isMemberRole(value.role) ||
    !isNonEmptyString(value.tokenHash) ||
    !isInteger(value.pid) ||
    typeof value.active !== 'boolean' ||
    !isFiniteNumber(value.joinedAt) ||
    !isOptionalString(value.agent) ||
    !isOptionalString(value.runId) ||
    !isOptionalInteger(value.childIndex) ||
    !isOptionalString(value.parentMemberId)
  )
    return undefined;
  const task = value.task === undefined ? undefined : parseTaskMetadata(value.task);
  if (value.task !== undefined && !task) return undefined;
  return {
    version: MEMBER_RECORD_VERSION,
    teamId: value.teamId,
    rootSessionId: value.rootSessionId,
    mainMemberId: value.mainMemberId,
    memberId: value.memberId,
    role: value.role,
    tokenHash: value.tokenHash,
    pid: value.pid,
    active: value.active,
    joinedAt: value.joinedAt,
    ...(isFiniteNumber(value.leftAt) ? { leftAt: value.leftAt } : {}),
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.childIndex !== undefined ? { childIndex: value.childIndex } : {}),
    ...(value.parentMemberId !== undefined ? { parentMemberId: value.parentMemberId } : {}),
    ...(task ? { task } : {}),
  };
}

function parseHeartbeatRecord(value: Record<string, unknown> | undefined): TeamHeartbeatRecord | undefined {
  const versioned = parseVersioned(value, [HEARTBEAT_RECORD_VERSION]);
  if (!versioned.ok || !value) return undefined;
  if (
    !isSafeId(value.memberId) ||
    !isNonEmptyString(value.tokenHash) ||
    !isInteger(value.pid) ||
    !isFiniteNumber(value.heartbeatAt)
  )
    return undefined;
  return {
    version: HEARTBEAT_RECORD_VERSION,
    memberId: value.memberId,
    tokenHash: value.tokenHash,
    pid: value.pid,
    heartbeatAt: value.heartbeatAt,
  };
}

function parseMessageEnvelope(value: Record<string, unknown> | undefined): TeamMessageEnvelope | undefined {
  const versioned = parseVersioned(value, [ENVELOPE_VERSION]);
  if (!versioned.ok || !value) return undefined;
  if (
    value.type !== TEAM_MESSAGE_TYPE ||
    !isSafeId(value.id) ||
    !isSafeId(value.teamId) ||
    !isMessageKind(value.kind) ||
    !isSafeId(value.fromMemberId) ||
    !isSafeId(value.toMemberId) ||
    !isNonEmptyString(value.senderTokenHash) ||
    !isInteger(value.seq) ||
    typeof value.message !== 'string' ||
    !withinBytes(value.message, MAX_MESSAGE_BYTES) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.expiresAt)
  )
    return undefined;
  return {
    type: TEAM_MESSAGE_TYPE,
    version: ENVELOPE_VERSION,
    id: value.id,
    teamId: value.teamId,
    kind: value.kind,
    fromMemberId: value.fromMemberId,
    toMemberId: value.toMemberId,
    senderTokenHash: value.senderTokenHash,
    seq: value.seq,
    message: value.message,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function parseReplyEnvelope(value: Record<string, unknown> | undefined): TeamReplyEnvelope | undefined {
  const versioned = parseVersioned(value, [ENVELOPE_VERSION]);
  if (!versioned.ok || !value) return undefined;
  if (
    value.type !== TEAM_REPLY_TYPE ||
    !isSafeId(value.requestId) ||
    !isSafeId(value.teamId) ||
    !isSafeId(value.fromMemberId) ||
    !isSafeId(value.toMemberId) ||
    !isNonEmptyString(value.senderTokenHash) ||
    typeof value.message !== 'string' ||
    !withinBytes(value.message, MAX_MESSAGE_BYTES) ||
    !isFiniteNumber(value.createdAt)
  )
    return undefined;
  return {
    type: TEAM_REPLY_TYPE,
    version: ENVELOPE_VERSION,
    requestId: value.requestId,
    teamId: value.teamId,
    fromMemberId: value.fromMemberId,
    toMemberId: value.toMemberId,
    senderTokenHash: value.senderTokenHash,
    message: value.message,
    createdAt: value.createdAt,
  };
}

function parseTeamToolParams(raw: unknown): TeamToolParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidRequest('Intercom params must be an object.', 'Use one documented intercom action shape.');
  }
  const params: Record<string, unknown> = raw as Record<string, unknown>;
  const action = TEAM_ACTIONS.find((candidate) => candidate === params.action);
  if (!action) {
    throw new DoomTeamExpectedError(
      'unsupported_operation',
      `Unsupported intercom action: ${String(params.action)}.`,
      false,
      'Use members, send, ask, pending, or reply.',
    );
  }
  if (!isOptionalString(params.to) || !isOptionalString(params.message) || !isOptionalString(params.requestId))
    throw invalidRequest(
      'Intercom to, message and requestId values must be strings.',
      'Correct the action fields and retry.',
    );
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

// ---------------------------------------------------------------------------
// Liveness
//
// `readMember`, `readHeartbeat` and `processAlive` are exported: they are the
// only readers of the member and heartbeat record formats this module owns,
// and `task-board.ts` reads through them for its own claim guard rather than
// keeping a second parser for the same on-disk shape. What is NOT exported is
// `memberIsActive`: it encodes THIS module's own liveness policy (fall back to
// `leftAt ?? joinedAt` when there is no heartbeat yet, because a member that
// has only just registered deserves a grace period before it is judged dead).
// `task-board.ts` needs a different policy for the same readers -- a missing
// heartbeat reads as dead, because it only ever gates a claim or a prune, and
// "unknown means dead" is the safe direction there. Sharing the predicate
// itself instead of the readers would force one of those two correct policies
// to lose.
// ---------------------------------------------------------------------------

export function readMember(root: TeamRootContext, memberId: string): TeamMemberRecord | undefined {
  return parseMemberRecord(readJsonRecord(memberPath(root, memberId)));
}

export function readHeartbeat(root: TeamRootContext, member: TeamMemberRecord): TeamHeartbeatRecord | undefined {
  const record = parseHeartbeatRecord(readJsonRecord(heartbeatPath(root, member.memberId)));
  // A heartbeat left by a previous owner of this name proves nothing about the
  // member that holds it now, which is exactly the resurrection FIX 6 targets.
  if (!record || record.memberId !== member.memberId || record.tokenHash !== member.tokenHash) return undefined;
  return record;
}

export function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to someone else, which still
    // answers the question being asked.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Last moment this member proved it was running, from its own writes only. */
function lastProofOfLife(root: TeamRootContext, member: TeamMemberRecord): number {
  return readHeartbeat(root, member)?.heartbeatAt ?? member.leftAt ?? member.joinedAt;
}

function memberIsActive(root: TeamRootContext, member: TeamMemberRecord, now: number): boolean {
  return member.active && processAlive(member.pid) && now - lastProofOfLife(root, member) <= HEARTBEAT_STALE_MS;
}

function writeMemberRecord(record: TeamMemberRecord): void {
  fs.mkdirSync(inboxDir(record, record.memberId), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  writePrivateAtomicJson(memberPath(record, record.memberId), record);
}

function writeHeartbeat(root: TeamRootContext, member: TeamMemberRecord, at: number): void {
  const record: TeamHeartbeatRecord = {
    version: HEARTBEAT_RECORD_VERSION,
    memberId: member.memberId,
    tokenHash: member.tokenHash,
    pid: member.pid,
    heartbeatAt: at,
  };
  writePrivateAtomicJson(heartbeatPath(root, member.memberId), record);
}

/** Exported: `task-board.ts` walks this to find every member's task claim without duplicating the readdir + parse. */
export function listMemberRecords(root: TeamRootContext): TeamMemberRecord[] {
  const dir = path.join(teamDir(root.teamId), MEMBERS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No members directory means no team on disk yet, which is not an error for
    // a caller that is only asking who is around.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSON_FILE_SUFFIX))
    .map((entry) => parseMemberRecord(readJsonRecord(path.join(dir, entry.name))))
    .filter((member): member is TeamMemberRecord => Boolean(member))
    .filter((member) => member.teamId === root.teamId && member.rootSessionId === root.rootSessionId);
}

function listActiveMembers(root: TeamRootContext, now: number): TeamMemberRecord[] {
  return listMemberRecords(root)
    .filter((member) => memberIsActive(root, member, now))
    .sort((left, right) => left.joinedAt - right.joinedAt || left.memberId.localeCompare(right.memberId));
}

export function readActiveNativeTeamSnapshot(now = Date.now()): NativeTeamSnapshot | undefined {
  const root = readNativeTeamRootFromEnvironment();
  if (!root) return undefined;
  return { members: listActiveMembers(root, now).map(publicMember) };
}

/**
 * FIX 7: drop the state of members that are long gone.
 *
 * Without this, every inbox directory and member record a session ever created
 * stays on disk, so `listMemberRecords` and the inbox readdir both grow for the
 * life of the machine's temp directory. The liveness rule is the same one used
 * everywhere else, plus a grace period, so nothing here can collect a member
 * that a peer still considers reachable.
 */
function collectDeadMembers(root: TeamRootContext, selfMemberId: string, now: number): number {
  let collected = 0;
  for (const member of listMemberRecords(root)) {
    if (member.memberId === selfMemberId) continue;
    if (memberIsActive(root, member, now)) continue;
    if (now - lastProofOfLife(root, member) <= HEARTBEAT_STALE_MS + TEAM_GC_GRACE_MS) continue;
    removeDirectory(inboxDir(root, member.memberId));
    removeFile(heartbeatPath(root, member.memberId));
    removeFile(memberPath(root, member.memberId));
    collected += 1;
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Team and membership lifecycle
// ---------------------------------------------------------------------------

export function ensureNativeTeamRoot(rootSessionId: string): TeamRootContext {
  const normalizedSessionId = rootSessionId.trim();
  if (!normalizedSessionId) throw new Error('A root session id is required for native team communication.');
  const root: TeamRootContext = {
    version: TEAM_ROOT_VERSION,
    teamId: teamIdForSession(normalizedSessionId),
    rootSessionId: normalizedSessionId,
    mainMemberId: MAIN_MEMBER_ID,
  };
  ensureTeamDirectories(root);
  const file = path.join(teamDir(root.teamId), TEAM_FILE);
  const existing = parseTeamRecord(readJsonRecord(file));
  if (existing && existing.rootSessionId !== normalizedSessionId)
    throw new Error('Native team identity collision detected.');
  const now = Date.now();
  const record: TeamRecord = { ...root, createdAt: existing?.createdAt ?? now, updatedAt: now };
  writePrivateAtomicJson(file, record);
  return root;
}

export function nativeTeamRootEnvironment(root: TeamRootContext): Record<string, string> {
  return {
    [SUBAGENT_TEAM_ID_ENV]: root.teamId,
    [SUBAGENT_TEAM_ROOT_SESSION_ENV]: root.rootSessionId,
    [SUBAGENT_TEAM_MAIN_MEMBER_ENV]: root.mainMemberId,
  };
}

/**
 * The environment a child needs to act as this member.
 *
 * The token travels only to the process that IS this member, which is what
 * makes FIX 4 coherent: the secret goes down the spawn path, never sideways in
 * an envelope.
 */
export function nativeTeamMemberEnvironment(context: TeamMemberContext): Record<string, string> {
  return {
    ...nativeTeamRootEnvironment(context),
    [SUBAGENT_TEAM_MEMBER_ID_ENV]: context.memberId,
    [SUBAGENT_TEAM_MEMBER_TOKEN_ENV]: context.token,
  };
}

export function clearNativeTeamMemberEnvironment(): Record<string, undefined> {
  return {
    [SUBAGENT_TEAM_MEMBER_ID_ENV]: undefined,
    [SUBAGENT_TEAM_MEMBER_TOKEN_ENV]: undefined,
  };
}

export function applyNativeTeamRootEnvironment(root: TeamRootContext): void {
  Object.assign(process.env, nativeTeamRootEnvironment(root));
}

export function clearNativeTeamRootEnvironment(root?: TeamRootContext): void {
  if (root && process.env[SUBAGENT_TEAM_ID_ENV] !== root.teamId) return;
  delete process.env[SUBAGENT_TEAM_ID_ENV];
  delete process.env[SUBAGENT_TEAM_ROOT_SESSION_ENV];
  delete process.env[SUBAGENT_TEAM_MAIN_MEMBER_ENV];
}

export function readNativeTeamRootFromEnvironment(): TeamRootContext | undefined {
  const teamId = textEnv(SUBAGENT_TEAM_ID_ENV);
  const rootSessionId = textEnv(SUBAGENT_TEAM_ROOT_SESSION_ENV);
  const mainMemberId = textEnv(SUBAGENT_TEAM_MAIN_MEMBER_ENV);
  if (!teamId || !isSafeId(teamId) || !rootSessionId || mainMemberId !== MAIN_MEMBER_ID) return undefined;
  if (teamId !== teamIdForSession(rootSessionId)) return undefined;
  const record = parseTeamRecord(readJsonRecord(path.join(teamDir(teamId), TEAM_FILE)));
  if (!record || record.rootSessionId !== rootSessionId || record.teamId !== teamId) return undefined;
  return { version: TEAM_ROOT_VERSION, teamId, rootSessionId, mainMemberId };
}

function validateTaskMetadata(task: TeamTaskMetadata | undefined): TeamTaskMetadata | undefined {
  if (!task) return undefined;
  const id = task.id.trim();
  const subject = task.subject.trim();
  if (!id || !withinBytes(id, MAX_TASK_ID_BYTES))
    throw new Error(`Native team task id must be between 1 and ${MAX_TASK_ID_BYTES} bytes.`);
  if (!subject || !withinBytes(subject, MAX_TASK_SUBJECT_BYTES))
    throw new Error(`Native team task subject must be between 1 and ${MAX_TASK_SUBJECT_BYTES} bytes.`);
  return { id, subject };
}

export interface RegisterNativeTeamMemberInput {
  root: TeamRootContext;
  role: TeamMemberRole;
  /** Explicit name. Becomes the member id verbatim once normalized. */
  name?: string;
  agent?: string;
  runId?: string;
  childIndex?: number;
  /** Present when this member is child N of a fanout; drives the `-N` suffix. */
  fanoutIndex?: number;
  parentMemberId?: string;
  task?: TeamTaskMetadata;
  pid?: number;
}

/**
 * Resolve the member id, which is also the member's name.
 *
 * Precedence is explicit name, then the agent name, because the caller that
 * passed a name meant it, while an agent name is only a sensible default.
 */
function resolveMemberId(input: RegisterNativeTeamMemberInput): string {
  if (input.role === 'main') return input.root.mainMemberId;
  const explicit = input.name !== undefined;
  if (!explicit && !input.agent) throw new Error('An intercom member needs a name or an agent to derive one from.');
  const base = guardReservedName(normalizeTeamMemberName(input.name ?? input.agent ?? FALLBACK_MEMBER_NAME), explicit);
  if (input.runId) {
    const suffix = normalizeTeamMemberName(input.runId).slice(0, 8);
    const room = MAX_MEMBER_NAME_LENGTH - suffix.length - FANOUT_SUFFIX_SEPARATOR.length;
    return `${base.slice(0, room).replace(SURROUNDING_SEPARATORS, '') || FALLBACK_MEMBER_NAME}-${suffix}`;
  }
  return input.fanoutIndex === undefined ? base : withFanoutOrdinal(base, input.fanoutIndex);
}

/**
 * Claim a name and join the team. Latest claimant wins.
 *
 * Taking a name over rotates the token, so the previous holder's next
 * `assertCurrentMember` fails and it stops acting as that member. Its inbox is
 * purged in the same step: those messages were addressed to a different process
 * with a different task, and delivering them to the new holder would be worse
 * than dropping them, since the sender is still alive to be told.
 */
export function registerNativeTeamMember(input: RegisterNativeTeamMemberInput): {
  context: TeamMemberContext;
  dispose: () => void;
} {
  const memberId = resolveMemberId(input);
  if (!isSafeId(memberId)) throw new Error('A safe native team member id is required.');
  const memberToken = newToken();
  const tokenHash = hash(memberToken);
  const now = Date.now();
  const task = validateTaskMetadata(input.task);
  const context: TeamMemberContext = {
    ...input.root,
    memberId,
    token: memberToken,
    role: input.role,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
    ...(input.parentMemberId ? { parentMemberId: input.parentMemberId } : {}),
    ...(task ? { task } : {}),
  };
  const previous = readMember(input.root, memberId);
  if (previous && previous.tokenHash !== tokenHash) removeDirectory(inboxDir(input.root, memberId));

  const { token: _unusedToken, version: _unusedVersion, ...identity } = context;
  const record: TeamMemberRecord = {
    ...identity,
    version: MEMBER_RECORD_VERSION,
    tokenHash,
    pid: input.pid ?? process.pid,
    active: true,
    joinedAt: now,
  };
  writeMemberRecord(record);
  writeHeartbeat(input.root, record, now);

  let disposed = false;
  return {
    context,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const current = readMember(input.root, memberId);
      // The name may already have been taken over. Writing then would hand the
      // new holder an inactive record it never asked for.
      if (!current || current.tokenHash !== tokenHash) return;
      const leftAt = Date.now();
      writeMemberRecord({ ...current, active: false, leftAt });
      writeHeartbeat(input.root, current, leftAt);
    },
  };
}

export function readNativeTeamMemberFromEnvironment(): TeamMemberContext | undefined {
  const root = readNativeTeamRootFromEnvironment();
  const memberId = textEnv(SUBAGENT_TEAM_MEMBER_ID_ENV);
  const memberToken = textEnv(SUBAGENT_TEAM_MEMBER_TOKEN_ENV);
  if (!root || !memberId || !isSafeId(memberId) || !memberToken) return undefined;
  const member = readMember(root, memberId);
  if (!member || member.teamId !== root.teamId || member.rootSessionId !== root.rootSessionId) return undefined;
  if (member.tokenHash !== hash(memberToken) || !member.active) return undefined;
  return {
    ...root,
    memberId,
    token: memberToken,
    role: member.role,
    ...(member.agent ? { agent: member.agent } : {}),
    ...(member.runId ? { runId: member.runId } : {}),
    ...(member.childIndex !== undefined ? { childIndex: member.childIndex } : {}),
    ...(member.parentMemberId ? { parentMemberId: member.parentMemberId } : {}),
    ...(member.task ? { task: member.task } : {}),
  };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function assertCurrentMember(context: TeamMemberContext, now: number): TeamMemberRecord {
  const member = readMember(context, context.memberId);
  if (!member || member.tokenHash !== hash(context.token) || !memberIsActive(context, member, now))
    throw new Error('This native team member is no longer active.');
  return member;
}

function resolveTarget(context: TeamMemberContext, to: string | undefined, now: number): TeamMemberRecord {
  const query = to?.trim();
  if (!query) throw invalidRequest('to is required for intercom send and ask.', 'Provide an explicit recipient.');
  const members = listActiveMembers(context, now).filter((member) => member.memberId !== context.memberId);
  const normalized = normalizeTeamMemberName(query);
  // The name is the id, so an id match is the answer whenever there is one.
  const exact = members.find((member) => member.memberId === query || member.memberId === normalized);
  if (exact) return exact;
  const lowered = query.toLowerCase();
  const matches = members.filter(
    (member) =>
      member.agent?.toLowerCase() === lowered ||
      member.runId?.toLowerCase() === lowered ||
      (lowered === MAIN_MEMBER_ID && member.role === 'main'),
  );
  if (matches.length === 1) return matches[0] as TeamMemberRecord;
  if (matches.length > 1) {
    throw new DoomTeamExpectedError(
      'recipient_ambiguous',
      `Multiple active intercom members match '${query}': ${matches.map((member) => member.memberId).join(', ')}.`,
      false,
      'Retry with one exact member id.',
    );
  }
  throw new DoomTeamExpectedError(
    'recipient_not_found',
    `Active intercom member '${query}' was not found.`,
    true,
    'Call intercom({"action":"members"}) and retry with an active member id.',
  );
}

function validateMessage(message: string | undefined): string {
  const normalized = message?.trim();
  if (!normalized)
    throw invalidRequest('message is required for intercom communication.', 'Provide a nonblank message.');
  if (!withinBytes(normalized, MAX_MESSAGE_BYTES)) {
    throw invalidRequest('Intercom message exceeds 64 KiB.', 'Shorten the message and retry.');
  }
  return normalized;
}

/**
 * Does this envelope really come from the member it names?
 *
 * FIX 4: compares hashes. The caller separately knows the file was found in its
 * own inbox directory, which is the other half of the check the predecessor
 * replaced with a bearer token it then leaked to the recipient.
 */
function senderAuthenticated(root: TeamRootContext, memberId: string, senderTokenHash: string): boolean {
  const member = readMember(root, memberId);
  return Boolean(member && member.tokenHash === senderTokenHash);
}

interface InboxScan {
  /** Deliverable, ordered per FIX 2. */
  messages: TeamMessageEnvelope[];
  /**
   * Files that parsed but belong to another team or another member.
   *
   * FIX 3: they are NOT removed, because they are not ours to destroy, and they
   * are reported so the caller can mark them seen. The predecessor left them in
   * place and unmarked, so every poll re-read and re-parsed every one of them.
   */
  foreignFiles: string[];
}

function scanInbox(context: TeamMemberContext, now: number, skip?: (fileName: string) => boolean): InboxScan {
  const dir = inboxDir(context, context.memberId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // The inbox is created at registration; a missing one means this member has
    // been collected or has not finished joining, and there is nothing to read.
    return { messages: [], foreignFiles: [] };
  }
  const messages: TeamMessageEnvelope[] = [];
  const foreignFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(JSON_FILE_SUFFIX)) continue;
    // Checked before the file is opened: this is what keeps an already-handled
    // file from costing a read and a parse on every poll.
    if (skip?.(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const envelope = parseMessageEnvelope(readJsonRecord(file));
    if (!envelope) {
      // Unparseable JSON in our own inbox is corrupt, not foreign: the atomic
      // writer's partial files are named `.tmp` and never seen here.
      removeFile(file);
      continue;
    }
    if (envelope.teamId !== context.teamId || envelope.toMemberId !== context.memberId) {
      foreignFiles.push(entry.name);
      continue;
    }
    if (envelope.expiresAt < now || !senderAuthenticated(context, envelope.fromMemberId, envelope.senderTokenHash)) {
      // Ours, and unusable: expired past its TTL, or from a member whose record
      // is gone so the message can never be authenticated.
      removeFile(file);
      continue;
    }
    messages.push(envelope);
  }
  return { messages: orderBySenderSequence(messages), foreignFiles };
}

/** The minimum a caller needs to know an ask exists, is addressed to a member, and is unanswered. */
export interface PendingTeamAsk {
  id: string;
  fromMemberId: string;
  createdAt: number;
}

/**
 * Unanswered `ask`s addressed to `targetMemberId`, for a runner-side caller
 * that is not `targetMemberId` itself and does not hold its token (for
 * example a deliverable guard checking on a subagent it spawned).
 *
 * READ-ONLY, DELIBERATELY NOT `scanInbox`: `scanInbox` deletes a corrupt file,
 * an expired file, and a file whose sender no longer authenticates, as a side
 * effect of scanning. That is correct for a poll loop, which owns the inbox
 * and is allowed to clean it up, but it is exactly wrong for a diagnostic
 * read: consuming a message as a side effect of merely asking about it would
 * make the message vanish for its real recipient, which is a worse bug than
 * the one this function exists to answer. This function only ever SKIPS a
 * file it cannot use when deciding what to report; it never calls
 * `removeFile` and never touches any in-memory "seen" state (it has no access
 * to another process's runtime instance to touch even if it wanted to). Do
 * not refactor this to share the scan loop with `scanInbox` -- that would
 * reintroduce the deletion as a side effect of a read.
 *
 * "Unanswered" needs no extra flag and none should be added: `replyToRequest`
 * removes the request file on reply, and `waitForReply`'s `finally` removes
 * it on timeout or cancellation too, so a valid, unexpired, sender-
 * authenticated `ask` file still sitting in the inbox always means nobody has
 * replied to it yet. A separate `answered` boolean would just be a second
 * place that fact could go stale.
 *
 * AUTHENTICATION: `caller` must be a currently active member of this exact
 * team, verified the same way every tool action verifies its caller
 * (`assertCurrentMember`). This is DELIBERATELY NARROWER than the plain
 * `TeamRootContext` the other exported readers (`readMember`, `readHeartbeat`,
 * `listMemberRecords`) accept, and that narrowing is not an inconsistency to
 * "fix" by loosening this to match them: a `TeamRootContext` is cheap to
 * reconstruct from a bare `rootSessionId` (`teamIdForSession` is a pure
 * function of it), so those readers' bar is really "knows or can guess a
 * session id". That is an acceptable bar for a static roster (who exists,
 * their role, their task) -- the same thing `list`/`status` already hand to
 * any member. It is not an acceptable bar for this function: who is asking
 * whom, and when, is a live activity signal, not roster data, so this
 * requires proof the caller is a real, currently-registered member with a
 * token that hashes to what is on disk. It deliberately does NOT require
 * `targetMemberId`'s own token: requiring that would mean handing it out to a
 * process that is not that member, which is exactly the impersonation
 * capability removing `senderToken` from the envelope (FIX 4) was there to
 * prevent. Do not let a future "simplification" walk either of those back.
 */
export function pendingAsksAddressedTo(
  caller: TeamMemberContext,
  targetMemberId: string,
  now: number,
): PendingTeamAsk[] {
  assertCurrentMember(caller, now);
  if (!isSafeId(targetMemberId)) return [];
  const dir = inboxDir(caller, targetMemberId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No inbox for this member: nothing pending, not an error.
    return [];
  }
  const pending: PendingTeamAsk[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(JSON_FILE_SUFFIX)) continue;
    const envelope = parseMessageEnvelope(readJsonRecord(path.join(dir, entry.name)));
    if (!envelope || envelope.kind !== 'ask') continue;
    if (envelope.teamId !== caller.teamId || envelope.toMemberId !== targetMemberId) continue;
    if (envelope.expiresAt < now) continue;
    if (!senderAuthenticated(caller, envelope.fromMemberId, envelope.senderTokenHash)) continue;
    pending.push({ id: envelope.id, fromMemberId: envelope.fromMemberId, createdAt: envelope.createdAt });
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/**
 * FIX 2: order within a sender by `seq`, and between senders by time.
 *
 * Implemented as a merge of per-sender queues rather than one comparator,
 * because "same sender by seq, different senders by createdAt" is not a
 * transitive relation and `Array.sort` on it would produce an order that
 * depends on the initial file listing.
 */
function orderBySenderSequence(messages: TeamMessageEnvelope[]): TeamMessageEnvelope[] {
  const bySender = new Map<string, TeamMessageEnvelope[]>();
  for (const envelope of messages) {
    const queue = bySender.get(envelope.fromMemberId);
    if (queue) queue.push(envelope);
    else bySender.set(envelope.fromMemberId, [envelope]);
  }
  const queues: TeamMessageEnvelope[][] = [];
  for (const queue of bySender.values()) {
    queue.sort((left, right) => left.seq - right.seq);
    queues.push(queue);
  }
  const ordered: TeamMessageEnvelope[] = [];
  for (;;) {
    let chosen: TeamMessageEnvelope[] | undefined;
    let chosenHead: TeamMessageEnvelope | undefined;
    for (const queue of queues) {
      const head = queue[0];
      if (!head) continue;
      if (
        !chosenHead ||
        head.createdAt < chosenHead.createdAt ||
        (head.createdAt === chosenHead.createdAt && head.fromMemberId < chosenHead.fromMemberId)
      ) {
        chosen = queue;
        chosenHead = head;
      }
    }
    if (!chosen || !chosenHead) break;
    chosen.shift();
    ordered.push(chosenHead);
  }
  return ordered;
}

function formatMember(member: TeamMemberRecord): string {
  const identity = member.role === 'main' ? MAIN_MEMBER_ID : (member.agent ?? member.memberId);
  const run = member.runId ? ` [${member.runId}]` : '';
  const task = member.task ? `, task ${member.task.id}: ${member.task.subject}` : '';
  return `- ${member.memberId}: ${identity}${run}${task}`;
}

function publicMember(member: TeamMemberRecord): NativeTeamMemberSnapshot {
  return {
    name: member.memberId,
    role: member.role,
    ...(member.agent ? { agent: member.agent } : {}),
    ...(member.runId ? { runId: member.runId } : {}),
    ...(member.task ? { task: member.task } : {}),
  };
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

function formatIncomingMessage(context: TeamMemberContext, envelope: TeamMessageEnvelope): string {
  const sender = readMember(context, envelope.fromMemberId);
  const identity = `${envelope.fromMemberId}${sender?.agent ? ` (${sender.agent})` : ''}`;
  const task = sender?.task ? `, task ${sender.task.id}` : '';
  const lines = [`${envelope.kind === 'ask' ? 'Question' : 'Message'} from ${identity}${task}.`];
  lines.push('', envelope.message);
  if (envelope.kind === 'ask') {
    lines.push(
      '',
      `Reply with ${NATIVE_TEAM_TOOL_NAME}({ action: "reply", requestId: "${envelope.id}", message: "..." }).`,
    );
  }
  return lines.join('\n');
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
  try {
    return pi.getAllTools().some((tool) => tool.name === name);
  } catch {
    // Tool enumeration is unavailable before the host binds its context. Saying
    // "not registered" is safe: registerTool is idempotent for our name.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface NativeTeamRuntime {
  bindMainSession(rootSessionId: string): TeamMemberContext;
  bindChildFromEnvironment(): TeamMemberContext | undefined;
  current(): TeamMemberContext | undefined;
  /** Messages given up on after `MAX_DELIVERY_ATTEMPTS`, most recent last. */
  undeliverable(): readonly UndeliverableTeamMessage[];
  dispose(): void;
}

/** Timing and limits, supplied by the service so tests can subclass and vary. */
interface TeamRuntimeOptions {
  pollIntervalMs: number;
  replyPollIntervalMs: number;
  heartbeatIntervalMs: number;
  gcIntervalMs: number;
  askTimeoutMs: number;
  maxDeliveryAttempts: number;
  now: () => number;
}

class TeamChannelRuntime implements NativeTeamRuntime {
  private context: TeamMemberContext | undefined;
  private ownedMembershipDispose: (() => void) | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeatAt = 0;
  private lastGcAt = 0;
  /** FIX 5: bounded. Keyed by file name so FIX 3 can skip before opening. */
  private readonly seenFiles = new BoundedKeySet<string>(SEEN_FILE_CAPACITY);
  private readonly deliveryAttempts = new LruCache<string, number>(DELIVERY_ATTEMPT_CAPACITY);
  private readonly undeliverableMessages: UndeliverableTeamMessage[] = [];
  /** FIX 2: this member's outbound counter, monotonic for its whole lifetime. */
  private outboundSeq = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: TeamRuntimeOptions,
  ) {
    if (hasTool(pi, NATIVE_TEAM_TOOL_NAME)) {
      throw new Error(
        `[tool_conflict] A foreign '${NATIVE_TEAM_TOOL_NAME}' tool is already registered. ` +
          'Recovery: disable the competing extension and reload Doom Team.',
      );
    }
    pi.registerTool(this.buildTool());
  }

  current(): TeamMemberContext | undefined {
    return this.context;
  }

  undeliverable(): readonly UndeliverableTeamMessage[] {
    return this.undeliverableMessages;
  }

  bindMainSession(rootSessionId: string): TeamMemberContext {
    const root = ensureNativeTeamRoot(rootSessionId);
    applyNativeTeamRootEnvironment(root);
    const membership = registerNativeTeamMember({ root, role: 'main' });
    return this.startBinding(membership.context, membership.dispose);
  }

  bindChildFromEnvironment(): TeamMemberContext | undefined {
    const childContext = readNativeTeamMemberFromEnvironment();
    if (!childContext) return undefined;
    if (this.context?.memberId === childContext.memberId && this.context.token === childContext.token)
      return this.context;
    return this.startBinding(childContext);
  }

  dispose(): void {
    const previous = this.context;
    this.stopBinding();
    if (previous?.role === 'main') clearNativeTeamRootEnvironment(previous);
  }

  private startBinding(nextContext: TeamMemberContext, dispose?: () => void): TeamMemberContext {
    this.stopBinding();
    this.context = nextContext;
    this.ownedMembershipDispose = dispose;
    this.poll();
    this.poller = setInterval(() => {
      this.poll();
    }, this.options.pollIntervalMs);
    this.poller.unref?.();
    return nextContext;
  }

  private stopBinding(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    this.ownedMembershipDispose?.();
    this.ownedMembershipDispose = undefined;
    this.seenFiles.clear();
    this.deliveryAttempts.clear();
    this.lastHeartbeatAt = 0;
    this.lastGcAt = 0;
    this.outboundSeq = 0;
    this.context = undefined;
  }

  private poll(): void {
    const context = this.context;
    if (!context) return;
    const now = this.options.now();
    this.heartbeat(context, now);
    this.collectGarbageIfDue(context, now);
    const scan = scanInbox(context, now, (fileName) => this.seenFiles.has(fileName));
    // FIX 3: skipped from here on, at the cost of one Set entry rather than a
    // read and a parse on every future poll.
    for (const fileName of scan.foreignFiles) this.seenFiles.add(fileName);
    for (const envelope of scan.messages) this.deliverOnce(context, envelope);
  }

  /**
   * FIX 1: deliver, then mark seen. Never the other way round.
   *
   * The predecessor added the id to its seen set and then called an unguarded
   * `deliver`. A throw from the host left the message marked as handled while it
   * had never been shown to anyone, and since it was seen it was never retried:
   * the message was lost with no trace. Here a failure leaves the file unseen so
   * the next poll retries it, and the attempt count is what stops a message the
   * host will never accept from blocking the inbox forever.
   */
  private deliverOnce(context: TeamMemberContext, envelope: TeamMessageEnvelope): void {
    const fileName = messageFileName(envelope.id);
    try {
      this.deliver(context, envelope);
    } catch (error) {
      const attempts = (this.deliveryAttempts.get(fileName) ?? 0) + FIRST_DELIVERY_ATTEMPT;
      if (attempts < this.options.maxDeliveryAttempts) {
        this.deliveryAttempts.set(fileName, attempts);
        return;
      }
      this.deliveryAttempts.delete(fileName);
      this.seenFiles.add(fileName);
      this.reportUndeliverable(context, envelope, attempts, error);
      return;
    }
    this.seenFiles.add(fileName);
    this.deliveryAttempts.delete(fileName);
    writePrivateAtomicJson(receiptPath(context, envelope.fromMemberId, envelope.id), {
      version: RECEIPT_VERSION,
      messageId: envelope.id,
      state: RECEIPT_DELIVERED,
      deliveredAt: this.options.now(),
    });
    // An `ask` file has to survive delivery: `replyToRequest` reads it back to
    // prove the reply answers a real question.
    if (envelope.kind === 'send') removeFile(messagePath(context, context.memberId, envelope.id));
  }

  private deliver(context: TeamMemberContext, envelope: TeamMessageEnvelope): void {
    const content = formatIncomingMessage(context, envelope);
    if (context.role === 'subagent') {
      // A subagent is mid-task, so the message is steered into the running turn
      // rather than starting a new one.
      this.pi.sendUserMessage(content, { deliverAs: 'steer' });
      return;
    }
    this.pi.sendMessage(
      {
        customType: TEAM_MESSAGE_CUSTOM_TYPE,
        content,
        display: true,
        details: {
          id: envelope.id,
          kind: envelope.kind,
          from: envelope.fromMemberId,
          to: envelope.toMemberId,
          seq: envelope.seq,
        },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    );
  }

  private reportUndeliverable(
    context: TeamMemberContext,
    envelope: TeamMessageEnvelope,
    attempts: number,
    error: unknown,
  ): boolean {
    const record: UndeliverableTeamMessage = {
      messageId: envelope.id,
      fromMemberId: envelope.fromMemberId,
      kind: envelope.kind,
      attempts,
      reason: errorText(error),
      at: this.options.now(),
    };
    this.undeliverableMessages.push(record);
    writePrivateAtomicJson(receiptPath(context, envelope.fromMemberId, envelope.id), {
      version: RECEIPT_VERSION,
      messageId: envelope.id,
      state: RECEIPT_FAILED,
      reason: record.reason,
      failedAt: record.at,
    });
    while (this.undeliverableMessages.length > UNDELIVERABLE_HISTORY_LIMIT) this.undeliverableMessages.shift();
    try {
      this.pi.sendMessage(
        {
          customType: TEAM_UNDELIVERABLE_CUSTOM_TYPE,
          content: `Native team message ${envelope.id} from ${envelope.fromMemberId} could not be delivered after ${attempts} attempts: ${record.reason}`,
          display: true,
          details: { ...record },
        },
        { triggerTurn: true, deliverAs: 'steer' },
      );
      return true;
    } catch {
      // The notice travels over the transport that just refused the message, so
      // it can fail for the same reason. `undeliverable()` is then the only
      // record, and rethrowing here would abort the poll and stall every other
      // sender's messages behind this one.
      return false;
    }
  }

  /** FIX 6: writes only this member's own heartbeat file. */
  private heartbeat(context: TeamMemberContext, now: number): void {
    if (now - this.lastHeartbeatAt < this.options.heartbeatIntervalMs) return;
    const member = readMember(context, context.memberId);
    if (!member || member.tokenHash !== hash(context.token) || !member.active) return;
    this.lastHeartbeatAt = now;
    writeHeartbeat(context, member, now);
  }

  private collectGarbageIfDue(context: TeamMemberContext, now: number): void {
    if (now - this.lastGcAt < this.options.gcIntervalMs) return;
    this.lastGcAt = now;
    try {
      collectDeadMembers(context, context.memberId, now);
    } catch (error) {
      // FIX 7 is housekeeping, not delivery. A sweep that fails is retried on
      // the next interval; letting it escape would stop the poll that delivers
      // messages, which is strictly worse than a directory left on disk.
      this.undeliverableMessages.push({
        messageId: '',
        fromMemberId: context.memberId,
        kind: 'send',
        attempts: 0,
        reason: `Native team directory sweep failed: ${errorText(error)}`,
        at: now,
      });
      while (this.undeliverableMessages.length > UNDELIVERABLE_HISTORY_LIMIT) this.undeliverableMessages.shift();
    }
  }

  private nextSeq(): number {
    this.outboundSeq += 1;
    return this.outboundSeq;
  }

  private queueMessage(
    context: TeamMemberContext,
    target: TeamMemberRecord,
    kind: TeamMessageKind,
    message: string,
    now: number,
    messageId: string,
  ): TeamMessageEnvelope {
    assertCurrentMember(context, now);
    if (!memberIsActive(context, target, now))
      throw new Error(`Native team member '${target.memberId}' is no longer active.`);
    const envelope: TeamMessageEnvelope = {
      type: TEAM_MESSAGE_TYPE,
      version: ENVELOPE_VERSION,
      id: messageId,
      teamId: context.teamId,
      kind,
      fromMemberId: context.memberId,
      toMemberId: target.memberId,
      senderTokenHash: hash(context.token),
      seq: this.nextSeq(),
      message,
      createdAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
    };
    fs.mkdirSync(inboxDir(context, target.memberId), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    writePrivateAtomicJson(messagePath(context, target.memberId, envelope.id), envelope);
    return envelope;
  }

  private replyToRequest(
    context: TeamMemberContext,
    requestId: string | undefined,
    message: string,
    now: number,
  ): TeamReplyEnvelope {
    if (!requestId || !isSafeId(requestId)) throw new Error('requestId must be a valid intercom request id.');
    assertCurrentMember(context, now);
    const requestFile = messagePath(context, context.memberId, requestId);
    const request = parseMessageEnvelope(readJsonRecord(requestFile));
    if (
      !request ||
      request.kind !== 'ask' ||
      request.teamId !== context.teamId ||
      request.toMemberId !== context.memberId ||
      !senderAuthenticated(context, request.fromMemberId, request.senderTokenHash)
    )
      throw new DoomTeamExpectedError(
        'recipient_not_found',
        `No pending intercom ask matches requestId '${requestId}'.`,
        false,
        'Call intercom({"action":"pending"}) and retry with an exact requestId.',
      );
    const reply: TeamReplyEnvelope = {
      type: TEAM_REPLY_TYPE,
      version: ENVELOPE_VERSION,
      requestId,
      teamId: context.teamId,
      fromMemberId: context.memberId,
      toMemberId: request.fromMemberId,
      senderTokenHash: hash(context.token),
      message,
      createdAt: now,
    };
    writePrivateAtomicJson(replyPath(context, requestId), reply);
    removeFile(requestFile);
    this.seenFiles.delete(messageFileName(requestId));
    return reply;
  }

  private async waitForReply(
    context: TeamMemberContext,
    target: TeamMemberRecord,
    request: TeamMessageEnvelope,
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<TeamReplyEnvelope> {
    const file = replyPath(context, request.id);
    const deadline = this.options.now() + (timeoutMs ?? this.options.askTimeoutMs);
    while (this.options.now() <= deadline) {
      if (signal?.aborted) throw new Error('Native team request cancelled.');
      const reply = parseReplyEnvelope(readJsonRecord(file));
      if (
        reply &&
        reply.teamId === context.teamId &&
        reply.requestId === request.id &&
        reply.fromMemberId === target.memberId &&
        reply.toMemberId === context.memberId &&
        senderAuthenticated(context, reply.fromMemberId, reply.senderTokenHash)
      ) {
        removeFile(file);
        return reply;
      }
      const currentTarget = readMember(context, target.memberId);
      if (!currentTarget || !memberIsActive(context, currentTarget, this.options.now()))
        throw new DoomTeamExpectedError(
          'communication_unavailable',
          `Intercom member '${target.memberId}' became unreachable before replying.`,
          true,
          'Call intercom({"action":"members"}) and decide whether to retry with an active member.',
        );
      await delay(this.options.replyPollIntervalMs, signal);
    }
    throw new DoomTeamExpectedError(
      'reply_timeout',
      `Timed out waiting for intercom member '${target.memberId}' to reply.`,
      true,
      'Check member status before deciding whether to ask again.',
    );
  }

  private buildTool(): ToolDefinition<typeof TeamToolParamsSchema, Record<string, unknown>> {
    return {
      name: NATIVE_TEAM_TOOL_NAME,
      label: 'Intercom',
      description:
        'Communicate with active agents in this root session. Use members, send, ask, pending, or reply. The stable root identity is main.',
      promptGuidelines: [
        'Send only new progress, blockers, or decisions. Do not repeat the task brief, sender task, or delegation instructions because the recipient already has them.',
      ],
      parameters: TeamToolParamsSchema,
      execute: async (operationId, rawParams, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> => {
        const context = this.context;
        if (!context) {
          throw new DoomTeamExpectedError(
            'communication_unavailable',
            'Intercom is not active for this session.',
            true,
            'Wait for session startup or reload Doom Team.',
          );
        }
        const params = parseTeamToolParams(rawParams);
        const now = this.options.now();
        assertCurrentMember(context, now);

        if (params.action === 'members') {
          const members = listActiveMembers(context, now);
          return {
            content: [
              { type: 'text', text: members.length ? members.map(formatMember).join('\n') : 'No active members.' },
            ],
            details: { members: members.map(publicMember) },
          };
        }
        if (params.action === 'pending') {
          // Deliberately scans without the seen filter: a pending ask has been
          // delivered already, so filtering by seen would hide every one of them.
          const asks = scanInbox(context, now).messages.filter((message) => message.kind === 'ask');
          const lines = asks.map(
            (ask) =>
              `- ${ask.id}: from ${ask.fromMemberId}. Reply with ${NATIVE_TEAM_TOOL_NAME}({ action: "reply", requestId: "${ask.id}", message: "..." }).`,
          );
          return {
            content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No pending native team asks.' }],
            details: { pending: asks.map((ask) => ({ id: ask.id, from: ask.fromMemberId, message: ask.message })) },
          };
        }

        const message = validateMessage(params.message);
        if (params.action === 'reply') {
          const reply = this.replyToRequest(context, params.requestId, message, now);
          return {
            content: [{ type: 'text', text: `Replied to native team request ${reply.requestId}.` }],
            details: { requestId: reply.requestId, to: reply.toMemberId },
          };
        }

        const target = resolveTarget(context, params.to, now);
        if (params.action === 'ask') {
          onUpdate?.({
            content: [{ type: 'text', text: `Waiting for ${target.memberId} to reply...` }],
            details: { action: 'ask', to: target.memberId, partial: true },
          });
        }
        const messageId = operationMessageId(context.memberId, operationId);
        const existingReceipt = readJsonRecord(receiptPath(context, context.memberId, messageId));
        if (existingReceipt?.state === RECEIPT_FAILED) {
          const reason = typeof existingReceipt.reason === 'string' ? existingReceipt.reason : 'unknown error';
          throw new DoomTeamExpectedError(
            'delivery_unconfirmed',
            `Intercom message ${messageId} failed: ${reason}`,
            false,
            'Call intercom({"action":"members"}) and do not resend automatically.',
          );
        }
        if (params.action === 'send' && existingReceipt?.state === RECEIPT_DELIVERED) {
          return {
            content: [{ type: 'text', text: `Message ${messageId} delivered to ${target.memberId}.` }],
            details: { state: RECEIPT_DELIVERED, delivered: true, messageId, to: target.memberId },
          };
        }
        const request = this.queueMessage(context, target, params.action, message, now, messageId);
        if (params.action === 'send') {
          return {
            content: [
              {
                type: 'text',
                text: `Message ${request.id} queued for ${target.memberId}; delivery is not yet confirmed. Do not resend.`,
              },
            ],
            details: {
              state: 'queued',
              delivered: false,
              messageId: request.id,
              to: target.memberId,
              seq: request.seq,
            },
          };
        }
        try {
          const reply = await this.waitForReply(context, target, request, signal, params.timeoutMs);
          return {
            content: [{ type: 'text', text: `Reply from ${target.memberId}:\n${reply.message}` }],
            details: { requestId: request.id, from: target.memberId, reply: reply.message },
          };
        } finally {
          // Whether it was answered, timed out or cancelled, the ask must not
          // stay in the target's inbox waiting for a reply nobody is reading.
          removeFile(messagePath(context, target.memberId, request.id));
        }
      },
    };
  }
}

export type NativeTeamChannelContract = {
  /** Create (or reuse) the runtime bound to one host instance. */
  createRuntime(pi: ExtensionAPI): NativeTeamRuntime;
  /** Bind this process as a team member when its environment says it is one. */
  registerClient(pi: ExtensionAPI): void;
};

/**
 * Owner of every team runtime in the process.
 *
 * WHY THIS IS A SERVICE AND NOT A MODULE-LEVEL WEAKMAP:
 * The predecessor kept the per-host runtime registry in a module-level WeakMap,
 * so the registry outlived any single session and could not be reset between
 * tests or between two sessions in one process. Timing lives here too, with
 * intervals kept as protected members that a test subclass can override.
 */
export class NativeTeamChannelService implements NativeTeamChannelContract {
  private readonly runtimes = new WeakMap<ExtensionAPI, NativeTeamRuntime>();

  protected readonly pollIntervalMs: number = CHANNEL_POLL_MS;
  protected readonly replyPollIntervalMs: number = REPLY_POLL_MS;
  protected readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS;
  protected readonly gcIntervalMs: number = TEAM_GC_INTERVAL_MS;
  protected readonly askTimeoutMs: number = DEFAULT_ASK_TIMEOUT_MS;
  protected readonly maxDeliveryAttempts: number = MAX_DELIVERY_ATTEMPTS;

  protected now(): number {
    return Date.now();
  }

  createRuntime(pi: ExtensionAPI): NativeTeamRuntime {
    const existing = this.runtimes.get(pi);
    if (existing) return existing;
    const runtime = new TeamChannelRuntime(pi, {
      pollIntervalMs: this.pollIntervalMs,
      replyPollIntervalMs: this.replyPollIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      gcIntervalMs: this.gcIntervalMs,
      askTimeoutMs: this.askTimeoutMs,
      maxDeliveryAttempts: this.maxDeliveryAttempts,
      now: () => this.now(),
    });
    this.runtimes.set(pi, runtime);
    pi.on('session_shutdown', () => {
      this.runtimes.get(pi)?.dispose();
    });
    return runtime;
  }

  registerClient(pi: ExtensionAPI): void {
    // Checked BEFORE readNativeTeamMemberFromEnvironment, which is not
    // scope-free: it resolves `teamDir()` and so requires a scope just to
    // answer "not a member". Activation runs before `session_start`, and the
    // parent puts its own PI_SUBAGENT_TEAM_* vars on `process.env`
    // (`applyNativeTeamRootEnvironment`), so a reload re-enters here with team
    // env set and no scope yet. No scope means this process is not a bound
    // child - a real one adopts its scope from the spawn environment first.
    if (!tryCurrentSessionScope()) return;
    if (!readNativeTeamMemberFromEnvironment()) return;
    this.createRuntime(pi).bindChildFromEnvironment();
  }
}
