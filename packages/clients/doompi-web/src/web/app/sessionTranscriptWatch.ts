import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import { readDormantTranscriptPage } from '../lib/hubApi';
import { createPagedTranscript } from '../stores/pagedTranscriptStore';
import { sessionsStore } from '../stores/sessionsStore';
import { applySessionFrame } from '../stores/sessionStore';
import { startProtocolRuntime } from './protocolRuntime';

/**
 * Keeps another session's transcript store filled while a plugin panel shows it.
 *
 * The page's own protocol runtime follows one session, the focused one, and a
 * hub subscription carries only plugin channels. A child session drawn inside
 * its parent's panel therefore gets a runtime of its own: a live session is
 * attached on a second connection and streams as its own tab would, while a
 * stopped one reads its history from disk, the way the focused runtime does.
 * The focused session needs nothing, since the page already follows it.
 */
export function watchSessionTranscript(sessionId: string): () => void {
  const { activeId, byId } = sessionsStore.state;
  if (sessionId === activeId) return () => undefined;
  const applyFrame = (target: string, frame: Record<string, unknown>, replay: boolean): void =>
    applySessionFrame(target, frame, { replay });

  if (byId[sessionId]?.summary.dormant === true) {
    const transcript = createPagedTranscript(
      sessionId,
      {
        readTranscriptPage: (request, context) => readDormantTranscriptPage(sessionId, request, context.abortSignal),
      },
      applyFrame,
      BACKGROUND_CONTEXT,
    );
    void transcript.initialize().catch((error: unknown) => {
      applyFrame(sessionId, { type: 'error', message: error instanceof Error ? error.message : String(error) }, false);
    });
    return () => transcript.dispose();
  }

  const runtime = startProtocolRuntime(window.location, applyFrame);
  runtime.focus(sessionId);
  return () => runtime.stop();
}
