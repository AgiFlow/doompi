import { EmptyState } from '@agimon-ai/doompi-web-components';
import { useEffect } from 'react';
import { sessionStoreFor } from '../../stores/sessionStore.ts';
import { subscribeThread, threadStoreKey, unsubscribeThread } from '../../stores/threadStore.ts';
import { Transcript } from './Timeline.tsx';

const THREAD_TEST_ID = 'thread-timeline';

/**
 * A thread of the focused session, such as a subagent run's own journal, on
 * the same transcript as the session itself and followed only while shown.
 * The parent session id goes down with it so tool cards resolve renderers
 * and slot props exactly as the main thread does.
 */
export function ThreadView({ sessionId, threadId }: { sessionId: string; threadId: string }) {
  useEffect(() => {
    subscribeThread(sessionId, threadId);
    return () => unsubscribeThread(sessionId, threadId);
  }, [sessionId, threadId]);

  return (
    <Transcript
      store={sessionStoreFor(threadStoreKey(sessionId, threadId))}
      sessionId={sessionId}
      testId={THREAD_TEST_ID}
      empty={
        <EmptyState
          data-testid="thread-empty"
          title="no messages yet"
          description="the agent's journal shows here as soon as it starts writing."
        />
      }
    />
  );
}
