import {
  Button,
  ChevronDownIcon,
  EmptyState,
  ExternalLinkIcon,
  Separator,
  StreamCursor,
} from '@agimon-ai/doompi-web-components';
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@tanstack/react-store';
import type { Store } from '@tanstack/store';
import { useActivityGroups } from '../../lib/composition.ts';
import { parseFileMentions } from '../../lib/fileMentions.ts';
import { pluginToolRenderer } from '../../lib/pluginRegistry.ts';
import { isSupportedImageMimeType, type SessionState, type TimelineEntry } from '../../lib/sessionModel.ts';
import {
  requestOlderHistory,
  sessionStoreFor,
  submitMessage,
  useActiveSession,
  useHasOlderHistory,
} from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { MentionPreviews } from './MentionPreviews.tsx';
import { MessageMarkdown } from './MessageMarkdown.tsx';
import { ToolCard } from './ToolCard.tsx';

const SUGGESTIONS = [
  'review the working tree and summarise the diff',
  'run the affected nx targets and report failures',
  'explain how the session socket handshake works',
];

/** Closer than this to the end counts as reading the latest, so new frames keep the view pinned. */
const PINNED_THRESHOLD_PX = 200;
/** Closer than this to the top asks for the window above, before the reader hits the edge. */
const PAGE_BACK_THRESHOLD_PX = 400;
/**
 * Entries at the end that are never skipped.
 *
 * Containment makes a skipped entry report its placeholder height, so a
 * transcript whose tail is contained has a scroll height that is only an
 * estimate, and following the newest line lands short of it. The tail is also
 * the part a reader is nearly always looking at, so there is nothing to skip
 * there; everything above it is what makes a long session slow.
 */
const LIVE_TAIL_ENTRIES = 40;

/**
 * The speaker's label.
 *
 * From `sm` up it holds a fixed column so every entry's text starts at the
 * same left edge and the labels line up down the page; trailing, that column
 * would only push the label away from the block it names, so it sizes to its
 * own text and sits beside it.
 *
 * Below `sm` there is no column at all. A phone has no width to spend on a
 * permanent left margin, so the label becomes a caption on its own line and
 * the entry runs the full width of the screen.
 */
function Gutter({ label, tone, trailing = false }: { label: string; tone: string; trailing?: boolean }) {
  const placement = trailing
    ? 'w-full text-right sm:w-auto sm:text-left'
    : 'w-full text-left sm:w-11 sm:pt-0.5 sm:text-right';
  return <span className={`shrink-0 text-[10px] font-bold ${placement} ${tone}`}>{label}</span>;
}

function ToolEntryRow({
  entry,
  sessionId,
}: {
  entry: Extract<TimelineEntry, { kind: 'tool' }>;
  sessionId: string | null;
}) {
  const statuses = useActiveSession((state) => state.statuses);
  const presentation = pluginToolRenderer(entry.name, statuses)?.timelinePresentation ?? 'tool';
  return (
    <div
      data-testid="entry-tool-row"
      data-tool-presentation={presentation}
      className="flex flex-col gap-1 sm:flex-row sm:gap-3"
    >
      {presentation === 'tool' ? <Gutter label="tool" tone="text-doom-faint" /> : null}
      <div className="min-w-0 flex-1">
        <ToolCard entry={entry} sessionId={sessionId} />
      </div>
    </div>
  );
}
const Entry = memo(function Entry({ entry, sessionId }: { entry: TimelineEntry; sessionId: string | null }) {
  if (entry.kind === 'user') {
    return (
      // What the reader said sits inboard of what the session said, on its own
      // surface: the transcript is a conversation, and two lanes tell the two
      // voices apart faster than a gutter label alone.
      // Column-reverse below `sm` keeps the trailing label reading as a
      // caption above the block, the same place the other voices' labels sit.
      <div
        data-testid="entry-user"
        className="flex flex-col-reverse gap-1 sm:flex-row sm:items-center sm:gap-3 sm:pl-10"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-doom-border-soft bg-doom-deep px-3.5 py-2.5 text-[13px] text-doom-hi">
          <MessageMarkdown sessionId={sessionId} text={entry.text} />
          {entry.images && entry.images.length > 0 ? (
            <div data-testid="user-attachments" className="flex flex-wrap gap-2">
              {entry.images
                .filter((image) => isSupportedImageMimeType(image.mimeType))
                .map((image, index) => (
                  <img
                    key={`${image.mimeType}:${image.data.slice(0, 24)}:${String(index)}`}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`Attached image ${String(index + 1)}`}
                    data-testid="user-attached-image"
                    className="h-auto max-h-80 max-w-full rounded-md object-contain"
                  />
                ))}
            </div>
          ) : null}
          {sessionId ? <MentionPreviews sessionId={sessionId} mentions={parseFileMentions(entry.text)} /> : null}
        </div>
        {/* The label trails what the reader said and the session's leads what
            it answered, so the two voices read as two lanes at a glance. */}
        <Gutter label="you" tone="text-doom-cyan" trailing />
      </div>
    );
  }

  if (entry.kind === 'assistant') {
    return (
      <div
        data-testid="entry-assistant"
        data-streaming={entry.streaming}
        className="flex flex-col gap-1 sm:flex-row sm:gap-3"
      >
        <Gutter label="pi" tone="text-doom-magenta" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {entry.thinking ? (
            <div
              data-testid="entry-thinking"
              // Grey, one step below the answer on the neutral ramp. Thinking is
              // context for the reply, not a second voice, and a coloured one
              // read as loudly as the reply it was only leading up to.
              className="text-[11px] text-doom-dim [&_strong]:text-doom-text [&_p]:whitespace-pre-wrap"
            >
              <MessageMarkdown sessionId={sessionId} text={entry.thinking} />
            </div>
          ) : null}
          <div className="text-[13px] text-doom-text">
            <MessageMarkdown sessionId={sessionId} text={entry.text} />
            {entry.streaming ? <StreamCursor /> : null}
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') return <ToolEntryRow entry={entry} sessionId={sessionId} />;

  if (entry.kind === 'settled') {
    return (
      <div data-testid="entry-settled" className="flex items-center gap-3 sm:pl-14">
        <Separator className="flex-1" />
        <span className="text-[10px] text-doom-faint">
          agent settled{entry.tools > 0 ? ` · ${entry.tools} tool${entry.tools === 1 ? '' : 's'}` : ''}
        </span>
        <Separator className="flex-1" />
      </div>
    );
  }

  if (entry.kind === 'queued') return null;
  // A notice: the agent's own aside (a mode switch, a refusal). Only an error
  // shouts; an informational one reads as a quiet system line.
  const isError = entry.tone === 'error';
  return (
    <div data-testid="entry-notice" data-tone={entry.tone} className="flex gap-2 sm:gap-3">
      {/* One character wide, so it stays beside its line even on a phone. */}
      <span
        className={`shrink-0 pt-0.5 text-[10px] font-bold sm:w-11 sm:text-right ${isError ? 'text-doom-red' : 'text-doom-faint'}`}
      >
        {isError ? '!' : '·'}
      </span>
      <p className={`min-w-0 flex-1 break-words text-[12px] ${isError ? 'text-doom-red' : 'text-doom-dim'}`}>
        {entry.text}
      </p>
    </div>
  );
});

function BackgroundWorkNotice() {
  return (
    <div
      role="status"
      data-testid="background-work-notice"
      className="mt-auto flex shrink-0 justify-center px-3 pt-2 pb-3"
    >
      <div className="max-w-lg rounded-md border border-doom-yellow/40 bg-doom-panel px-3 py-2 text-center text-[10px] leading-relaxed text-doom-yellow">
        Background work is still running. The agent will resume when results are ready.
      </div>
    </div>
  );
}

/**
 * One transcript, whichever fold it reads: the focused session's own, or a
 * thread of it. Owns the scroll pinning; the caller owns the empty state and
 * the session the entries' tool cards act on.
 *
 * `limit` and `compact` are for a fold that is not a whole surface, such as a
 * grid card: only the newest entries, drawn tighter, with no history paging
 * and no jump control, because a card is a glance and not a place to read.
 */
export function Transcript({
  store,
  sessionId,
  empty,
  testId = 'timeline',
  backgroundWorkActive = false,
  limit,
  compact = false,
}: {
  store: Store<SessionState>;
  sessionId: string | null;
  empty: ReactNode;
  testId?: string;
  backgroundWorkActive?: boolean;
  limit?: number;
  compact?: boolean;
}) {
  const entries = useStore(store, (state) => state.entries);
  const visibleEntries = useMemo(() => {
    const shown = entries.filter((entry) => entry.kind !== 'queued');
    return limit === undefined ? shown : shown.slice(-limit);
  }, [entries, limit]);
  const scroller = useRef<HTMLDivElement>(null);
  // The transcript's height as of the last entry. Whether to follow the newest
  // line is decided against this rather than against a scroll event, because
  // an event fires after the fact and a fast run can grow the transcript
  // before the browser has reported the reader's scroll.
  const lastHeight = useRef(0);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const hasOlder = useHasOlderHistory(sessionId);
  // Where the bottom of the transcript sat before a window was prepended.
  // Restoring against this is what keeps the reader's place: prepending grows
  // the scroll height above them, and the browser would otherwise leave the
  // viewport where it was and the content would appear to jump.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // The first entry's key. A window prepended above the reader changes it, and
  // nothing else does: an entry arriving at the bottom, or the streaming one
  // growing, leaves the top of the transcript alone. That is the difference
  // between holding the reader's place and refusing to follow a live run.
  const firstId = useRef<string | null>(null);

  const atBottom = (element: HTMLDivElement, height: number): boolean =>
    element.scrollTop + element.clientHeight >= height - PINNED_THRESHOLD_PX;

  const followLatest = (): void => {
    const element = scroller.current;
    if (!element || !following.current) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    setUnread(false);
  };

  const jumpToLatest = (): void => {
    following.current = true;
    setUnread(false);
    followLatest();
  };

  /** Reaching the bottom by hand is the same as never having left it. */
  const onScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const bottom = atBottom(element, element.scrollHeight);
    following.current = bottom;
    if (bottom) setUnread(false);
    // A compact fold shows a fixed tail of a live thread; asking for the
    // window above it would page history nobody can read there.
    if (!compact && element.scrollTop <= PAGE_BACK_THRESHOLD_PX && hasOlder) {
      anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      requestOlderHistory(sessionId);
    }
  };

  /** Wheel input is explicit intent to leave the live tail. */
  const onWheel = (): void => {
    following.current = false;
  };

  // A different fold starts at the bottom of its transcript.
  useLayoutEffect(() => {
    lastHeight.current = 0;
    firstId.current = null;
    anchor.current = null;
    following.current = true;
    setUnread(false);
  }, [store]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // A prepended window grew the transcript upwards; hold the reader where
    // they were by moving down by exactly what appeared above them.
    const held = anchor.current;
    const prepended =
      visibleEntries.length > 0 && firstId.current !== null && visibleEntries[0]?.id !== firstId.current;
    firstId.current = visibleEntries[0]?.id ?? null;
    if (held !== null && prepended) {
      anchor.current = null;
      const grew = element.scrollHeight - held.height;
      if (grew > 0) {
        element.scrollTop = held.top + grew;
        lastHeight.current = element.scrollHeight;
        return;
      }
    }
    // The first layout and later streaming growth pin directly to the live tail.
    // Repeated easing fights the changing target and makes token streaming jitter.
    if (lastHeight.current === 0) {
      element.scrollTop = element.scrollHeight;
      lastHeight.current = element.scrollHeight;
      following.current = true;
      setUnread(false);
      return;
    }
    const shouldFollow = following.current || atBottom(element, lastHeight.current);
    lastHeight.current = element.scrollHeight;
    if (shouldFollow) {
      following.current = true;
      setUnread(false);
      followLatest();
      return;
    }
    setUnread(true);
  }, [visibleEntries]);

  if (visibleEntries.length === 0) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {empty}
        {backgroundWorkActive ? <BackgroundWorkNotice /> : null}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        onWheel={onWheel}
        data-testid={testId}
        className={
          compact
            ? 'flex flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2'
            : 'flex flex-1 flex-col gap-[18px] overflow-y-auto px-2 py-4 sm:px-[26px] sm:py-[22px]'
        }
      >
        {visibleEntries.map((entry, index) => (
          // Entries above the live tail are skipped for layout and paint until
          // they are scrolled near. A long transcript is thousands of markdown
          // blocks, diffs and tool cards, and laying all of them out on every
          // scroll is what makes an old session crawl. The browser does this
          // rather than a measured list in JS, because entry heights vary by an
          // order of magnitude and a list that guesses them wrong moves the
          // reader's place under them.
          <div
            key={entry.id}
            className={
              index < visibleEntries.length - LIVE_TAIL_ENTRIES
                ? '[contain-intrinsic-size:auto_64px] [content-visibility:auto]'
                : undefined
            }
          >
            <Entry entry={entry} sessionId={sessionId} />
          </div>
        ))}
        {backgroundWorkActive ? <BackgroundWorkNotice /> : null}
      </div>
      {unread && !compact ? (
        <Button
          variant="subtle"
          size="sm"
          data-testid="timeline-jump"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-doom-border shadow-lg animate-doom-rise"
        >
          <ChevronDownIcon className="h-3 w-3" />
          new activity below
        </Button>
      ) : null}
    </div>
  );
}

/** The focused session's conversation; an empty one offers a few openers. */
export function Timeline() {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const settled = useActiveSession((state) => state.settled);
  // Only worth saying once the agent has stopped: while it is still running the
  // transcript already shows the work, and the notice would just be noise.
  const hasActiveWork = useActivityGroups(statuses, widgets, activeId).some((group) => group.active);
  const backgroundWorkActive = settled && hasActiveWork;
  return (
    <Transcript
      store={sessionStoreFor(activeId)}
      sessionId={activeId}
      backgroundWorkActive={backgroundWorkActive}
      empty={
        <EmptyState
          data-testid="timeline"
          title="no messages yet"
          description="this session is attached and waiting. anything you send goes straight to the supervised agent."
        >
          <div data-testid="timeline-empty" className="mt-2 flex w-full flex-col gap-1.5">
            {SUGGESTIONS.map((suggestion, index) => (
              <Button
                key={suggestion}
                variant="outline"
                size="lg"
                data-testid={`suggestion-${index}`}
                onClick={() => submitMessage(suggestion)}
                className="h-auto justify-between bg-doom-panel px-3 py-2 text-left font-normal text-doom-text"
              >
                <span className="flex-1 truncate">{suggestion}</span>
                <ExternalLinkIcon className="h-3 w-3 shrink-0 text-doom-faint" />
              </Button>
            ))}
          </div>
        </EmptyState>
      }
    />
  );
}
