import type { Context } from '@earendil-works/chord';
import {
  defineDoc,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type Session,
} from '@earendil-works/pi-durable';

/** External session identity is independent of the currently selected conversation. */
export const DurableNavigationDoc = defineDoc<{
  activeConversationId: ConversationId | null;
  branches: { conversationId: ConversationId; sourceConversationId: ConversationId; targetId: EntryId | null }[];
}>({
  kind: 'doompi.navigation',
  version: 1,
  scope: 'session',
  initial: () => ({ activeConversationId: null, branches: [] }),
});

/** Select the initial conversation without overwriting a previously persisted selection. */
export async function initializeDurableNavigation(
  session: Session,
  conversationId: ConversationId,
  context: Context,
): Promise<ConversationId> {
  return session.commit(async (tx) => {
    if (!(await tx.conversation(conversationId))) throw new Error('Initial conversation does not exist');
    const navigation = await tx.doc(DurableNavigationDoc);
    navigation.activeConversationId ??= conversationId;
    return navigation.activeConversationId;
  }, context);
}

/**
 * Fork the selected history, retaining its abandoned tail. A head marker alone cannot rewind.
 * The caller must settle active work and prepare any summary before entering this transaction.
 * Expected selection guards against a stale asynchronous summary switching a newer selection.
 */
export async function navigateDurableConversation(
  session: Session,
  expectedConversationId: ConversationId,
  targetId: EntryId | null,
  context: Context,
  options?: { summary?: EntryDraft },
): Promise<ConversationId> {
  return session.commit(async (tx) => {
    const navigation = await tx.doc(DurableNavigationDoc);
    if (navigation.activeConversationId !== expectedConversationId)
      throw new Error('The active conversation changed during navigation');
    const next =
      targetId === null
        ? await tx.createConversation({ ownership: { kind: 'ownerless' } })
        : await tx.forkConversation(expectedConversationId, targetId, { ownership: { kind: 'ownerless' } });
    if (options?.summary) await tx.appendEntry(next.id, options.summary);
    navigation.branches.push({
      conversationId: next.id,
      sourceConversationId: expectedConversationId,
      targetId,
    });
    navigation.activeConversationId = next.id;
    return next.id;
  }, context);
}
