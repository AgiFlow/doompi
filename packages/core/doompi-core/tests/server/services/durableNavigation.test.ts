import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSession, MemoryStorage, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { expect, it } from 'vitest';

import {
  DurableNavigationDoc,
  initializeDurableNavigation,
  navigateDurableConversation,
} from '../../../src/services/durableNavigation';

const context = BACKGROUND_CONTEXT;

async function fixture() {
  const session = createSession(new MemoryStorage());
  const source = await session.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    const target = await tx.appendEntry(conversation.id, { kind: 'test.message', data: 'target' });
    const tail = await tx.appendEntry(conversation.id, { kind: 'test.message', data: 'abandoned' });
    return { conversation, target, tail };
  }, context);
  await initializeDurableNavigation(session, source.conversation.id, context);
  const entries = (id: ConversationId) =>
    session.commit(async (tx) => (await tx.scanEntries({ conversationId: id }, 100)).items, context);
  return { session, source, entries };
}

it('forks at the target, preserves the abandoned history and atomically selects the fork with a summary', async () => {
  const { session, source, entries } = await fixture();
  try {
    const selected = await navigateDurableConversation(session, source.conversation.id, source.target.id, context, {
      summary: { kind: 'branch_summary', data: { summary: 'Abandoned work' } },
    });
    expect((await entries(selected)).map((entry) => entry.kind)).toEqual(['branch_summary', 'test.message']);
    expect((await entries(selected)).at(-1)?.id).toBe(source.target.id);
    expect((await entries(source.conversation.id)).map((entry) => entry.id)).toEqual([
      source.tail.id,
      source.target.id,
    ]);
    expect(await session.snapshot(DurableNavigationDoc, context)).toEqual({
      activeConversationId: selected,
      branches: [
        { conversationId: selected, sourceConversationId: source.conversation.id, targetId: source.target.id },
      ],
    });
    expect(await initializeDurableNavigation(session, source.conversation.id, context)).toBe(selected);
  } finally {
    await session.close(context);
  }
});

it('navigates to the empty root and rejects stale selection without changing it', async () => {
  const { session, source, entries } = await fixture();
  try {
    const selected = await navigateDurableConversation(session, source.conversation.id, null, context);
    expect(await entries(selected)).toEqual([]);
    await expect(
      navigateDurableConversation(session, source.conversation.id, source.target.id, context),
    ).rejects.toThrow('active conversation changed');
    expect((await session.snapshot(DurableNavigationDoc, context))?.activeConversationId).toBe(selected);
  } finally {
    await session.close(context);
  }
});

it('persists the selected fork and source history across a SQLite reopen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-durable-navigation-'));
  const file = path.join(directory, 'session.sqlite');
  let session = createSession(await openNodeSqliteStorage(file));
  try {
    const source = await session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      const target = await tx.appendEntry(conversation.id, { kind: 'test.message', data: 'target' });
      await tx.appendEntry(conversation.id, { kind: 'test.message', data: 'tail' });
      return { conversation, target };
    }, context);
    await initializeDurableNavigation(session, source.conversation.id, context);
    const selected = await navigateDurableConversation(session, source.conversation.id, source.target.id, context);
    await session.close(context);
    session = createSession(await openNodeSqliteStorage(file));
    expect((await session.snapshot(DurableNavigationDoc, context))?.activeConversationId).toBe(selected);
    const histories = await session.commit(
      async (tx) => ({
        selected: (await tx.scanEntries({ conversationId: selected }, 100)).items,
        original: (await tx.scanEntries({ conversationId: source.conversation.id }, 100)).items,
      }),
      context,
    );
    expect(histories.selected.map((entry) => entry.data)).toEqual(['target']);
    expect(histories.original.map((entry) => entry.data)).toEqual(['tail', 'target']);
  } finally {
    await session.close(context);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('rolls back the selection and fork metadata when a target is not visible', async () => {
  const { session, source } = await fixture();
  try {
    const other = await session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      return tx.appendEntry(conversation.id, { kind: 'test.message' });
    }, context);
    await expect(navigateDurableConversation(session, source.conversation.id, other.id, context)).rejects.toThrow();
    expect(await session.snapshot(DurableNavigationDoc, context)).toEqual({
      activeConversationId: source.conversation.id,
      branches: [],
    });
  } finally {
    await session.close(context);
  }
});
