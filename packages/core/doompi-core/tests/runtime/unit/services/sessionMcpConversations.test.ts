import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionMcpConversationStore,
  sessionMcpConversationDigest,
} from '../../../../src/services/sessionMcpConversations';

const roots: string[] = [];
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-conversations-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const digest = (value: string): string => sessionMcpConversationDigest({ 'openai/session': value })!;

describe('conversation routing state', () => {
  it('accepts only bounded exact conversation metadata and never persists its raw value', () => {
    for (const meta of [
      undefined,
      null,
      [],
      {},
      { 'openai/session': '' },
      { 'openai/session': ' a' },
      { 'openai/session': 'a\n' },
      { 'openai/session': 42 },
      { 'openai/session': 'x'.repeat(1025) },
    ])
      expect(sessionMcpConversationDigest(meta)).toBeUndefined();
    expect(digest('chat-a')).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest('chat-a')).not.toBe(digest('chat-b'));
    const root = directory();
    createSessionMcpConversationStore(root).reserve('client', 'parent', 'workspace', digest('private-chat-id'));
    expect(fs.readFileSync(path.join(root, 'session-mcp-conversations.json'), 'utf8')).not.toContain('private-chat-id');
  });

  it('reserves once, separates registrations, and reloads the same association', () => {
    const root = directory();
    const store = createSessionMcpConversationStore(root);
    const first = store.reserve('client-a', 'parent', 'workspace', digest('chat'));
    expect(store.reserve('client-a', 'parent', 'workspace', digest('chat'))).toEqual(first);
    expect(store.reserve('client-b', 'parent', 'workspace', digest('chat')).id).not.toBe(first.id);
    expect(store.reserve('client-a', 'other-parent', 'workspace', digest('chat')).id).not.toBe(first.id);
    expect(createSessionMcpConversationStore(root).find('client-a', 'parent', digest('chat'))).toEqual(first);
    expect(() => store.get(first.id, 'other-parent')).toThrow('unavailable');
  });

  it('fixes the directory before binding and preserves closed tombstones', () => {
    const root = directory();
    const store = createSessionMcpConversationStore(root);
    const first = store.reserve('client', 'parent', 'workspace', digest('chat'));
    expect(() => store.bind(first.id, 'parent', 'target')).toThrow('prepared');
    const cwd = path.join(root, 'checkout');
    store.prepare(first.id, 'parent', cwd);
    expect(() => store.prepare(first.id, 'parent', path.join(root, 'elsewhere'))).toThrow('different');
    expect(store.bind(first.id, 'parent', 'target').state).toBe('bound');
    expect(store.bind(first.id, 'parent', 'target').cwd).toBe(cwd);
    expect(() => store.bind(first.id, 'parent', 'another')).toThrow('cannot change');
    store.closeSession(first.id);
    expect(store.reserve('client', 'parent', 'workspace', digest('chat'))).toMatchObject({
      id: first.id,
      state: 'closed',
    });
    expect(() => createSessionMcpConversationStore(root).get(first.id, 'parent')).toThrow('unavailable');
  });

  it('persists trusted setup kind and bounded failures without changing legacy bindings', () => {
    const root = directory();
    const store = createSessionMcpConversationStore(root);
    const worktree = store.reserve('client', 'parent', 'workspace', digest('worktree'));
    const legacy = store.reserve('client', 'parent', 'workspace', digest('legacy'));
    expect(legacy.setupKind).toBeUndefined();
    store.selectSetup(worktree.id, 'parent', 'managed-worktree');
    store.prepare(worktree.id, 'parent', path.join(root, 'worktree'));
    expect(() => store.selectSetup(worktree.id, 'parent', 'existing-directory')).toThrow('cannot change');
    expect(() => store.selectSetup(legacy.id, 'parent', 'managed-worktree')).not.toThrow();
    store.fail(worktree.id, 'parent', 'SESSION_WORKTREE_PROVISION_FAILED');
    expect(createSessionMcpConversationStore(root).get(worktree.id, 'parent')).toMatchObject({
      setupKind: 'managed-worktree',
      failureCode: 'SESSION_WORKTREE_PROVISION_FAILED',
      state: 'pending',
    });
    expect(store.selectSetup(worktree.id, 'parent', 'managed-worktree').failureCode).toBeUndefined();
    store.fail(worktree.id, 'parent', 'SESSION_WORKTREE_PROVISION_FAILED');
    expect(store.bind(worktree.id, 'parent', 'workspace').failureCode).toBeUndefined();
    expect(store.fail(worktree.id, 'parent', 'SESSION_UNAVAILABLE').state).toBe('bound');
  });

  it('rejects ambiguous prepared legacy setup and malformed optional metadata without losing evidence', () => {
    const root = directory();
    const store = createSessionMcpConversationStore(root);
    const legacy = store.reserve('client', 'parent', 'workspace', digest('legacy'));
    store.prepare(legacy.id, 'parent', path.join(root, 'checkout'));
    expect(() => store.selectSetup(legacy.id, 'parent', 'managed-worktree')).toThrow('no verified provider');
    expect(() => store.selectSetup(legacy.id, 'parent', 'existing-directory')).toThrow('no verified provider');
    const file = path.join(root, 'session-mcp-conversations.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      original.replace('"state": "pending"', '"state": "pending", "failureCode": "raw git error"'),
    );
    expect(() => createSessionMcpConversationStore(root).list()).toThrow('could not be loaded');
    expect(fs.readFileSync(file, 'utf8')).toContain('raw git error');
  });

  it('fails closed on corruption and duplicate bindings without overwriting evidence', () => {
    const root = directory();
    const file = path.join(root, 'session-mcp-conversations.json');
    fs.writeFileSync(file, 'broken');
    const store = createSessionMcpConversationStore(root);
    expect(() => store.reserve('client', 'parent', 'workspace', digest('chat'))).toThrow('could not be loaded');
    expect(fs.readFileSync(file, 'utf8')).toBe('broken');
    fs.rmSync(file);
    const first = createSessionMcpConversationStore(root).reserve('client', 'parent', 'workspace', digest('chat'));
    fs.writeFileSync(file, JSON.stringify({ version: 1, bindings: [first, first] }));
    expect(() => createSessionMcpConversationStore(root).list()).toThrow('could not be loaded');
  });

  it('does not publish a reservation after a persistence failure', () => {
    const root = directory();
    const state = path.join(root, 'state');
    const store = createSessionMcpConversationStore(state);
    fs.writeFileSync(state, 'not a directory');
    expect(() => store.reserve('client', 'parent', 'workspace', digest('chat'))).toThrow('could not be saved');
    expect(store.list()).toEqual([]);
  });

  it('revokes only the selected registration and closes all bindings owned by a removed parent', () => {
    const store = createSessionMcpConversationStore(directory());
    const a = store.reserve('a', 'parent', 'workspace', digest('chat'));
    const b = store.reserve('b', 'parent', 'workspace', digest('chat'));
    store.closeClient('a');
    expect(() => store.get(a.id, 'parent')).toThrow('unavailable');
    expect(store.get(b.id, 'parent').state).toBe('pending');
    store.closeSession('parent');
    expect(() => store.get(b.id, 'parent')).toThrow('unavailable');
  });
});
