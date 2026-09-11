import type { DoomDirectEventBus } from '@agimon-ai/doompi-extension-contracts/hub-channel';

export const GIT_WORKTREE_LIFECYCLE_EVENT = 'git_worktree_lifecycle';
export const GIT_WORKTREE_MESSAGE_EVENT = 'git_worktree_message';
export const WORKTREE_MESSAGE_VERSION = 1 as const;
export const MAX_WORKTREE_MESSAGE_BYTES = 64 * 1024;
export const MAX_WORKTREE_INBOX_MESSAGES = 100;

export interface WorktreeLifecycleEvent {
  readonly version: typeof WORKTREE_MESSAGE_VERSION;
  readonly repositoryRoot: string;
}

export type WorktreeMessageParty = 'parent' | 'child';

export interface WorktreeMessage {
  readonly version: typeof WORKTREE_MESSAGE_VERSION;
  readonly worktreeId: string;
  readonly fromSessionId: string;
  readonly from: WorktreeMessageParty;
  readonly text: string;
  readonly sentAt: string;
}

export interface WorktreeMessageInbox {
  send(targetSessionId: string, message: WorktreeMessage): void;
  receive(worktreeId: string): WorktreeMessage[];
  close(): void;
}

function isMessageParty(value: unknown): value is WorktreeMessageParty {
  return value === 'parent' || value === 'child';
}

function parseMessage(value: unknown): WorktreeMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<WorktreeMessage>;
  if (record.version !== WORKTREE_MESSAGE_VERSION) return undefined;
  if (typeof record.worktreeId !== 'string' || record.worktreeId === '') return undefined;
  if (typeof record.fromSessionId !== 'string' || record.fromSessionId === '') return undefined;
  if (!isMessageParty(record.from)) return undefined;
  if (typeof record.text !== 'string' || record.text === '') return undefined;
  if (Buffer.byteLength(record.text, 'utf8') > MAX_WORKTREE_MESSAGE_BYTES) return undefined;
  if (typeof record.sentAt !== 'string' || record.sentAt === '') return undefined;
  return record as WorktreeMessage;
}

export function createWorktreeMessageInbox(directEvents: DoomDirectEventBus, sessionId: string): WorktreeMessageInbox {
  if (sessionId === '') throw new Error('The Git message service requires a session identity.');
  const messages = new Map<string, WorktreeMessage[]>();
  const unsubscribe = directEvents.subscribe(GIT_WORKTREE_MESSAGE_EVENT, sessionId, (payload) => {
    const message = parseMessage(payload);
    if (message === undefined) return;
    const inbox = messages.get(message.worktreeId) ?? [];
    if (inbox.length >= MAX_WORKTREE_INBOX_MESSAGES) inbox.shift();
    inbox.push(message);
    messages.set(message.worktreeId, inbox);
  });
  let closed = false;
  return {
    send(targetSessionId, message) {
      if (closed) throw new Error('The Git message service is closed.');
      directEvents.publish(GIT_WORKTREE_MESSAGE_EVENT, targetSessionId, message);
    },
    receive(worktreeId) {
      if (closed) return [];
      const inbox = messages.get(worktreeId);
      if (inbox === undefined) return [];
      messages.delete(worktreeId);
      return inbox;
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      messages.clear();
    },
  };
}

export function isWorktreeLifecycleEvent(value: unknown): value is WorktreeLifecycleEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<WorktreeLifecycleEvent>;
  return (
    record.version === WORKTREE_MESSAGE_VERSION &&
    typeof record.repositoryRoot === 'string' &&
    record.repositoryRoot !== ''
  );
}
