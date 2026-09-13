import type {
  ProtocolEvent,
  SessionService,
  SessionServiceState,
  TranscriptPage,
} from '@agimon-ai/doompi-core/session-protocol';
import { type Context } from '@earendil-works/chord';

import { recordBrowserPerformance } from '../lib/browserTelemetry';
import {
  bindHistoryReader,
  resetSessionStore,
  beginSessionReplay,
  endSessionReplay,
  releaseProtocolTranscript,
  setHasNewerHistory,
} from './sessionStore';

const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_BUFFER = 512;
type Direction = 'older' | 'newer' | 'latest';

/** A bounded history window with a separate live event subscription. */
export function createPagedTranscript(
  sessionId: string,
  service: Pick<SessionService, 'readTranscriptPage'>,
  onFrame: (sessionId: string, frame: Record<string, unknown>, replay: boolean) => void,
  context: Context,
) {
  let pages: TranscriptPage[] = [];
  let revision = 0;
  let loading = false;
  let disposed = false;
  let overflow = false;
  let reloadPending = false;
  let buffered: ProtocolEvent[] = [];
  let latestState: SessionServiceState | undefined;
  let drafts: TranscriptPage['drafts'] = [];
  const emit = (frame: Record<string, unknown>, replay = false) => onFrame(sessionId, frame, replay);
  const atLatest = () => pages.at(-1)?.newerCursor === null;
  const rebuild = () => {
    const started = performance.now();
    releaseProtocolTranscript(sessionId);
    beginSessionReplay(sessionId);
    try {
      resetSessionStore(sessionId);
      for (const event of latestState?.presentation?.projections ?? []) emit(event.frame, true);
      for (const entry of pages[0]?.context ?? []) emit({ type: 'entry_appended', entry }, true);
      for (const page of pages) for (const entry of page.entries) emit({ type: 'entry_appended', entry }, true);
      if (atLatest())
        for (const draft of drafts) {
          if (draft.role === 'assistant') {
            for (const part of draft.content) {
              if (part.type === 'text')
                emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: part.text } }, true);
              if (part.type === 'thinking')
                emit(
                  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: part.thinking } },
                  true,
                );
            }
          } else if (draft.role === 'tool') {
            emit(
              {
                type: 'tool_execution_start',
                toolCallId: draft.toolCallId,
                toolName: draft.toolName,
                args: draft.input,
              },
              true,
            );
            emit(
              {
                type: 'tool_execution_update',
                toolCallId: draft.toolCallId,
                partialResult: { content: draft.content },
              },
              true,
            );
          }
        }
      if (latestState?.snapshot.phase === 'turn') emit({ type: 'agent_start' }, true);
      setHasNewerHistory(sessionId, !atLatest());
    } finally {
      endSessionReplay(sessionId);
      recordBrowserPerformance({
        name: 'web.browser.transcript_render',
        duration_ms: performance.now() - started,
        count: pages.reduce((count, page) => count + page.entries.length, 0),
      });
    }
  };
  const apply = (event: ProtocolEvent) => {
    if (event.sequence <= revision) return;
    if (revision > 0 && event.sequence > revision + 1) {
      request('latest');
      return;
    }
    revision = event.sequence;
    const frame = event.frame;
    if (frame.type === 'navigation_end' || frame.type === 'message_end') {
      request('latest');
      return;
    }
    if (
      !atLatest() &&
      [
        'message_start',
        'message_update',
        'message_end',
        'entry_appended',
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
        'agent_settled',
      ].includes(frame.type)
    )
      return;
    if (
      frame.type === 'entry_appended' &&
      frame.entry &&
      typeof frame.entry === 'object' &&
      !Array.isArray(frame.entry)
    ) {
      const entry = frame.entry;
      if (
        !pages.some((page) =>
          page.entries.some((item) => item && typeof item === 'object' && !Array.isArray(item) && item.id === entry.id),
        )
      ) {
        let tail = pages.at(-1);
        if (tail && tail.entries.length >= PAGE_SIZE) {
          const identity = [...tail.context, ...tail.entries].findLast(
            (item) =>
              item && typeof item === 'object' && !Array.isArray(item) && item.customType === 'doom-profile-identity',
          );
          tail = {
            ...tail,
            context: identity ? [identity] : [],
            entries: [],
            olderCursor: tail.endCursor,
            startCursor: null,
            drafts: [],
          };
          pages.push(tail);
          if (pages.length > MAX_PAGES) pages.shift();
        }
        if (tail) {
          tail.entries.push(entry);
          tail.endCursor = typeof frame.transcriptCursor === 'string' ? frame.transcriptCursor : tail.endCursor;
          tail.startCursor ??= tail.endCursor;
        }
      }
    }
    emit(frame);
  };
  const load = async (direction: Direction): Promise<void> => {
    loading = true;
    const cursor = direction === 'older' ? pages[0]?.olderCursor : pages.at(-1)?.newerCursor;
    try {
      const started = performance.now();
      const page = await service.readTranscriptPage(
        direction === 'latest' ? {} : { cursor: cursor!, direction },
        context,
      );
      recordBrowserPerformance({
        name: 'web.browser.transcript_page',
        duration_ms: performance.now() - started,
        count: page.entries.length,
      });
      if (disposed) return;
      if (direction === 'latest') pages = [page];
      else if (direction === 'older') {
        pages.unshift(page);
        if (pages.length > MAX_PAGES) {
          pages.pop();
          const tail = pages.at(-1)!;
          tail.newerCursor = tail.endCursor;
        }
      } else {
        pages.push(page);
        if (pages.length > MAX_PAGES) {
          pages.shift();
          pages[0]!.olderCursor = pages[0]!.startCursor;
        }
      }
      if (direction !== 'latest') for (const event of buffered) if (event.sequence <= page.revision) apply(event);
      drafts = page.drafts;
      revision = Math.max(revision, page.revision);
      rebuild();
    } finally {
      loading = false;
      const events = buffered;
      buffered = [];
      if (!disposed) {
        if (overflow || reloadPending) {
          overflow = false;
          reloadPending = false;
          request('latest');
        } else for (const event of events) apply(event);
      }
    }
  };
  const request = (direction: Direction): boolean => {
    if (disposed) return false;
    if (loading) {
      if (direction === 'latest') reloadPending = true;
      return false;
    }
    if (direction === 'older' && !pages[0]?.olderCursor) return false;
    if (direction === 'newer' && !pages.at(-1)?.newerCursor) return false;
    void load(direction).catch((error: unknown) => {
      if (disposed) return;
      if (String(error).includes('STALE_TRANSCRIPT_CURSOR') && direction !== 'latest') request('latest');
      else emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  };
  const unbind = bindHistoryReader(sessionId, request);
  return {
    initialize: () => load('latest'),
    publish(state: SessionServiceState) {
      const previous = latestState?.presentation?.revision;
      latestState = state;
      if (previous !== undefined && state.presentation && state.presentation.revision < previous) {
        revision = 0;
        request('latest');
        return;
      }
      for (const event of state.presentation?.events ?? []) {
        if (loading || pages.length === 0) {
          if (event.sequence <= revision || event.sequence <= (buffered.at(-1)?.sequence ?? -1)) continue;
          buffered.push(event);
          if (buffered.length > MAX_BUFFER) {
            overflow = true;
            buffered = buffered.slice(-MAX_BUFFER);
          }
        } else apply(event);
      }
    },
    dispose() {
      disposed = true;
      unbind();
      pages = [];
      buffered = [];
    },
  };
}
