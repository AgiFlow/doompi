import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_FILE = 'session-mcp-conversations.json';
const STORE_VERSION = 1;
const MAX_BINDINGS = 1000;
const MAX_CONVERSATION_BYTES = 1024;
const CONVERSATION_META_KEY = 'openai/session';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type SessionMcpSetupKind = 'managed-worktree' | 'existing-directory';
export type SessionMcpSetupFailureCode = 'SESSION_WORKTREE_PROVISION_FAILED' | 'SESSION_UNAVAILABLE';

/** Client metadata is a routing hint within an authenticated registration, never authority. */
export function sessionMcpConversationDigest(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const value = (meta as Record<string, unknown>)[CONVERSATION_META_KEY];
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    Buffer.byteLength(value, 'utf8') > MAX_CONVERSATION_BYTES
  )
    return undefined;
  return createHash('sha256')
    .update(JSON.stringify(['chatgpt', value]))
    .digest('hex');
}

export interface SessionMcpConversation {
  /** Also the server-reserved target session identity. Never supplied by the model. */
  readonly id: string;
  readonly clientId: string;
  readonly parentSessionId: string;
  readonly parentWorkspaceId: string;
  readonly conversationDigest: string;
  readonly createdAt: string;
  readonly state: 'pending' | 'bound' | 'closed';
  /** Host-selected execution provider. Old records without this field are not assumed to be worktrees. */
  readonly setupKind?: SessionMcpSetupKind;
  /** Public, bounded failure code. Never persist Git stderr or exception text here. */
  readonly failureCode?: SessionMcpSetupFailureCode;
  /** Persisted before checkout or session creation starts. */
  readonly cwd?: string;
  readonly workspaceId?: string;
}

export class SessionMcpConversationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly bindingId?: string,
  ) {
    super(message);
    this.name = 'SessionMcpConversationError';
  }
}

export interface SessionMcpConversationStore {
  list(): readonly SessionMcpConversation[];
  find(clientId: string, parentSessionId: string, digest: string): SessionMcpConversation | undefined;
  reserve(clientId: string, parentSessionId: string, parentWorkspaceId: string, digest: string): SessionMcpConversation;
  get(id: string, parentSessionId: string): SessionMcpConversation;
  selectSetup(id: string, parentSessionId: string, kind: SessionMcpSetupKind): SessionMcpConversation;
  prepare(id: string, parentSessionId: string, cwd: string): SessionMcpConversation;
  fail(id: string, parentSessionId: string, code: SessionMcpSetupFailureCode): SessionMcpConversation;
  bind(id: string, parentSessionId: string, workspaceId: string): SessionMcpConversation;
  recover(id: string, parentSessionId: string): SessionMcpConversation;
  closeSession(sessionId: string): void;
  closeClient(clientId: string): void;
}

function validRecord(value: unknown): value is SessionMcpConversation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SessionMcpConversation>;
  return (
    typeof record.id === 'string' &&
    ID_PATTERN.test(record.id) &&
    typeof record.clientId === 'string' &&
    ID_PATTERN.test(record.clientId) &&
    typeof record.parentSessionId === 'string' &&
    ID_PATTERN.test(record.parentSessionId) &&
    typeof record.parentWorkspaceId === 'string' &&
    record.parentWorkspaceId.length > 0 &&
    typeof record.conversationDigest === 'string' &&
    DIGEST_PATTERN.test(record.conversationDigest) &&
    typeof record.createdAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    (record.state === 'pending' || record.state === 'bound' || record.state === 'closed') &&
    (record.setupKind === undefined ||
      record.setupKind === 'managed-worktree' ||
      record.setupKind === 'existing-directory') &&
    (record.failureCode === undefined ||
      record.failureCode === 'SESSION_WORKTREE_PROVISION_FAILED' ||
      record.failureCode === 'SESSION_UNAVAILABLE') &&
    (record.failureCode === undefined || record.state === 'pending') &&
    (record.cwd === undefined ||
      (typeof record.cwd === 'string' && path.isAbsolute(record.cwd) && !record.cwd.includes('\0'))) &&
    (record.workspaceId === undefined || (typeof record.workspaceId === 'string' && record.workspaceId.length > 0)) &&
    (record.state !== 'bound' || (record.cwd !== undefined && record.workspaceId !== undefined))
  );
}

function routingKey(
  record: Pick<SessionMcpConversation, 'clientId' | 'parentSessionId' | 'conversationDigest'>,
): string {
  return JSON.stringify([record.clientId, record.parentSessionId, record.conversationDigest]);
}

/** One owning headless host persists these bindings. Corruption never becomes an empty, reusable store. */
export function createSessionMcpConversationStore(stateDir: string): SessionMcpConversationStore {
  const file = path.join(stateDir, STORE_FILE);
  let failure: Error | undefined;
  let current: readonly SessionMcpConversation[] = load();

  function load(): readonly SessionMcpConversation[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid store');
      const stored = parsed as { version?: unknown; bindings?: unknown };
      if (stored.version !== STORE_VERSION || !Array.isArray(stored.bindings) || !stored.bindings.every(validRecord))
        throw new Error('Invalid bindings');
      const records: SessionMcpConversation[] = stored.bindings;
      if (
        records.length > MAX_BINDINGS ||
        new Set(records.map((record) => record.id)).size !== records.length ||
        new Set(records.map(routingKey)).size !== records.length
      )
        throw new Error('Duplicate or excessive bindings');
      return Object.freeze(records.map((record) => Object.freeze(record)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      failure = new SessionMcpConversationError(
        'CONVERSATION_STORE_UNAVAILABLE',
        'Conversation bindings could not be loaded. Restore the binding store before using conversation routing.',
      );
      return [];
    }
  }

  function list(): readonly SessionMcpConversation[] {
    if (failure) throw failure;
    return current;
  }

  function persist(next: readonly SessionMcpConversation[]): void {
    list();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ version: STORE_VERSION, bindings: next }, null, 2)}\n`);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
      current = Object.freeze(next.map((record) => Object.freeze(record)));
    } catch {
      throw new SessionMcpConversationError(
        'CONVERSATION_STORE_UNAVAILABLE',
        'Conversation bindings could not be saved. No new execution target was admitted.',
      );
    } finally {
      // This temporary file never grants access and can safely be left for local recovery.
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* An inaccessible temporary file is not loaded. */
      }
    }
  }

  function get(id: string, parentSessionId: string): SessionMcpConversation {
    const record = list().find((entry) => entry.id === id && entry.parentSessionId === parentSessionId);
    if (!record || record.state === 'closed')
      throw new SessionMcpConversationError(
        'SESSION_UNAVAILABLE',
        'This conversation binding is unavailable. It will not be recreated automatically.',
      );
    return record;
  }

  function replace(record: SessionMcpConversation): SessionMcpConversation {
    persist(list().map((entry) => (entry.id === record.id ? record : entry)));
    return get(record.id, record.parentSessionId);
  }

  return {
    list,
    get,
    find: (clientId, parentSessionId, digest) =>
      list().find(
        (record) =>
          record.clientId === clientId &&
          record.parentSessionId === parentSessionId &&
          record.conversationDigest === digest,
      ),
    reserve(clientId, parentSessionId, parentWorkspaceId, digest) {
      const existing = list().find(
        (record) =>
          record.clientId === clientId &&
          record.parentSessionId === parentSessionId &&
          record.conversationDigest === digest,
      );
      if (existing) return existing;
      if (list().length >= MAX_BINDINGS)
        throw new SessionMcpConversationError(
          'CONVERSATION_LIMIT_REACHED',
          'The conversation binding limit has been reached. Use a dedicated session connection.',
        );
      const record: SessionMcpConversation = {
        id: randomUUID(),
        clientId,
        parentSessionId,
        parentWorkspaceId,
        conversationDigest: digest,
        createdAt: new Date().toISOString(),
        state: 'pending',
      };
      if (!validRecord(record))
        throw new SessionMcpConversationError('INVALID_CONVERSATION', 'Invalid conversation identity.');
      persist([...list(), record]);
      return get(record.id, parentSessionId);
    },
    selectSetup(id, parentSessionId, kind) {
      const record = get(id, parentSessionId);
      if (record.setupKind === kind)
        return record.failureCode === undefined ? record : replace({ ...record, failureCode: undefined });
      if (record.setupKind !== undefined && (record.cwd !== undefined || record.state === 'bound'))
        throw new SessionMcpConversationError(
          'SESSION_TARGET_FIXED',
          'An initialized setup cannot change its provider.',
          id,
        );
      if (record.setupKind === undefined && record.cwd !== undefined)
        throw new SessionMcpConversationError(
          'SESSION_TARGET_FIXED',
          'This existing setup has no verified provider. Recover it without changing its ownership.',
          id,
        );
      return replace({ ...record, setupKind: kind, failureCode: undefined });
    },
    prepare(id, parentSessionId, cwd) {
      const record = get(id, parentSessionId);
      if (!path.isAbsolute(cwd) || cwd.includes('\0'))
        throw new Error('A canonical absolute execution directory is required.');
      if (record.cwd !== undefined && record.cwd !== cwd)
        throw new SessionMcpConversationError(
          'SESSION_TARGET_FIXED',
          'This conversation already reserved a different execution directory. Recover that setup instead.',
          id,
        );
      if (record.cwd === cwd) return record;
      return replace({ ...record, cwd });
    },
    fail(id, parentSessionId, code) {
      const record = get(id, parentSessionId);
      if (record.state !== 'pending' || record.failureCode === code) return record;
      return replace({ ...record, failureCode: code });
    },
    bind(id, parentSessionId, workspaceId) {
      const record = get(id, parentSessionId);
      if (!record.cwd || !workspaceId) throw new Error('A prepared directory and admitted workspace are required.');
      if (record.state === 'bound') {
        if (record.workspaceId !== workspaceId) throw new Error('The bound workspace cannot change.');
        return record;
      }
      return replace({ ...record, state: 'bound', workspaceId, failureCode: undefined });
    },
    recover(id, parentSessionId) {
      const record = list().find((entry) => entry.id === id && entry.parentSessionId === parentSessionId);
      if (!record)
        throw new SessionMcpConversationError('SESSION_UNAVAILABLE', 'This conversation binding is unavailable.');
      return replace({ ...record, state: 'pending' });
    },
    closeSession(sessionId) {
      const next = list().map((record): SessionMcpConversation =>
        record.id === sessionId || record.parentSessionId === sessionId ? { ...record, state: 'closed' } : record,
      );
      if (next.some((record, index) => record !== current[index])) persist(next);
    },
    closeClient(clientId) {
      const next = list().map((record): SessionMcpConversation =>
        record.clientId === clientId ? { ...record, state: 'closed' } : record,
      );
      if (next.some((record, index) => record !== current[index])) persist(next);
    },
  };
}
