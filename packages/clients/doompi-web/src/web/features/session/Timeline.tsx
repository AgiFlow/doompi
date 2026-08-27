import {
  Badge,
  Button,
  ChevronDownIcon,
  EmptyState,
  ExternalLinkIcon,
  Markdown,
  RefreshIcon,
  Separator,
  StreamCursor,
} from '@agimon-ai/doompi-web-components';
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@tanstack/react-store';
import type { Store } from '@tanstack/store';
import { parseFileMentions } from '../../lib/fileMentions.ts';
import type { SessionState, TimelineEntry } from '../../lib/sessionModel.ts';
import { requestOlderHistory, sessionStoreFor, submitMessage, useHasOlderHistory } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { MentionPreviews } from './MentionPreviews.tsx';
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
 * Leading, it holds a fixed column so every entry's text starts at the same
 * left edge and the labels line up down the page. Trailing, that column would
 * only push the label away from the block it names, so it sizes to its own
 * text and sits beside it.
 */
function Gutter({ label, tone, trailing = false }: { label: string; tone: string; trailing?: boolean }) {
  return (
    <span className={`shrink-0 text-[10px] font-bold ${trailing ? 'text-left' : 'w-11 pt-0.5 text-right'} ${tone}`}>
      {label}
    </span>
  );
}

const Entry = memo(function Entry({ entry, sessionId }: { entry: TimelineEntry; sessionId: string | null }) {
  if (entry.kind === 'user') {
    return (
      // What the reader said sits inboard of what the session said, on its own
      // surface: the transcript is a conversation, and two lanes tell the two
      // voices apart faster than a gutter label alone.
      <div data-testid="entry-user" className="flex items-center gap-3 pl-4 sm:pl-10">
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-doom-border-soft bg-doom-deep px-3.5 py-2.5 text-[13px] text-doom-hi">
          <Markdown text={entry.text} />
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
      <div data-testid="entry-assistant" data-streaming={entry.streaming} className="flex gap-3">
        <Gutter label="pi" tone="text-doom-magenta" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {entry.thinking ? (
            <div
              data-testid="entry-thinking"
              className="text-[11px] text-doom-violet/80 [&_strong]:text-doom-violet [&_p]:whitespace-pre-wrap"
            >
              <Markdown text={entry.thinking} />
            </div>
          ) : null}
          <div className="text-[13px] text-doom-text">
            <Markdown text={entry.text} />
            {entry.streaming ? <StreamCursor /> : null}
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') {
    return (
      <div className="flex gap-3">
        <Gutter label="tool" tone="text-doom-faint" />
        <div className="min-w-0 flex-1">
          <ToolCard entry={entry} sessionId={sessionId} />
        </div>
      </div>
    );
  }

  if (entry.kind === 'settled') {
    return (
      <div data-testid="entry-settled" className="flex items-center gap-3 pl-14">
        <Separator className="flex-1" />
        <span className="text-[10px] text-doom-faint">
          agent settled{entry.tools > 0 ? ` · ${entry.tools} tool${entry.tools === 1 ? '' : 's'}` : ''}
        </span>
        <Separator className="flex-1" />
      </div>
    );
  }

  if (entry.kind === 'queued') {
    return (
      <div data-testid="entry-queued" className="flex pl-[58px]">
        <Badge size="md" className="self-start bg-doom-panel text-[10px]">
          <RefreshIcon className="h-3 w-3 shrink-0 text-doom-cyan" />
          queued follow-up: &quot;{entry.text}&quot;
        </Badge>
      </div>
    );
  }

  // A notice: the agent's own aside (a mode switch, a refusal). Only an error
  // shouts; an informational one reads as a quiet system line.
  const isError = entry.tone === 'error';
  return (
    <div data-testid="entry-notice" data-tone={entry.tone} className="flex gap-3">
      <Gutter label={isError ? '!' : '·'} tone={isError ? 'text-doom-red' : 'text-doom-faint'} />
      <p className={`min-w-0 flex-1 break-words text-[12px] ${isError ? 'text-doom-red' : 'text-doom-dim'}`}>
        {entry.text}
      </p>
    </div>
  );
});

/**
 * One transcript, whichever fold it reads: the focused session's own, or a
 * thread of it. Owns the scroll pinning; the caller owns the empty state and
 * the session the entries' tool cards act on.
 */
export function Transcript({
  store,
  sessionId,
  empty,
  testId = 'timeline',
}: {
  store: Store<SessionState>;
  sessionId: string | null;
  empty: ReactNode;
  testId?: string;
}) {
  const entries = useStore(store, (state) => state.entries);
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
    if (element.scrollTop <= PAGE_BACK_THRESHOLD_PX && hasOlder) {
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
    const prepended = entries.length > 0 && firstId.current !== null && entries[0]?.id !== firstId.current;
    firstId.current = entries[0]?.id ?? null;
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
  }, [entries]);

  if (entries.length === 0) return <>{empty}</>;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        onWheel={onWheel}
        data-testid={testId}
        className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-3 py-4 sm:px-[26px] sm:py-[22px]"
      >
        {entries.map((entry, index) => (
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
              index < entries.length - LIVE_TAIL_ENTRIES
                ? '[contain-intrinsic-size:auto_64px] [content-visibility:auto]'
                : undefined
            }
          >
            <Entry entry={entry} sessionId={sessionId} />
          </div>
        ))}
      </div>
      {unread ? (
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
  return (
    <Transcript
      store={sessionStoreFor(activeId)}
      sessionId={activeId}
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
