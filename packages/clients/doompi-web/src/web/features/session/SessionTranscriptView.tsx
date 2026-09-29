import type { ThreadViewOptions } from '@agimon-ai/doompi-core/web';
import { EmptyState } from '@agimon-ai/doompi-web-components';
import { useEffect } from 'react';

import { sessionStoreFor } from '../../stores/sessionStore';
import { Transcript } from './Timeline';

const SESSION_TRANSCRIPT_TEST_ID = 'session-transcript';

/**
 * Another session's conversation, drawn inside a plugin panel of the focused one.
 *
 * It reads the same store the session's own tab reads. `watch` is what fills
 * that store while this is mounted without focusing the session; the app owns
 * it because only the app can open a protocol connection.
 */
export function SessionTranscriptView({
  sessionId,
  options,
  watch,
}: {
  sessionId: string;
  options?: ThreadViewOptions;
  watch: (sessionId: string) => () => void;
}) {
  useEffect(() => watch(sessionId), [sessionId, watch]);

  return (
    <Transcript
      store={sessionStoreFor(sessionId)}
      sessionId={sessionId}
      historyKey={sessionId}
      testId={SESSION_TRANSCRIPT_TEST_ID}
      limit={options?.limit}
      compact={options?.compact}
      empty={
        <EmptyState
          data-testid="session-transcript-empty"
          title="no messages yet"
          description="the session's conversation shows here as soon as its agent starts."
        />
      }
    />
  );
}
