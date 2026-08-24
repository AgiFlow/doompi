import { Button, ChevronDownIcon, EmptyState, StreamCursor } from '@agimon-ai/doompi-web-components';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@tanstack/react-store';
import { Markdown } from '../../components/Markdown.tsx';
import { parseFileMentions } from '../../lib/fileMentions.ts';
import type { TimelineEntry } from '../../lib/sessionModel.ts';
import { submitMessage, useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { MentionPreviews } from './MentionPreviews.tsx';
import { ToolCard } from './ToolCard.tsx';

const SUGGESTIONS = [
  'review the working tree and summarise the diff',
  'run the affected nx targets and report failures',
  'explain how the session socket handshake works',
];

/** Closer than this to the end counts as reading the latest, so new frames keep the view pinned. */
const PINNED_THRESHOLD_PX = 48;

function Gutter({ label, tone }: { label: string; tone: string }) {
  return <span className={`w-11 shrink-0 pt-0.5 text-right text-[10px] font-bold ${tone}`}>{label}</span>;
}

function Entry({ entry, sessionId }: { entry: TimelineEntry; sessionId: string | null }) {
  if (entry.kind === 'user') {
    return (
      <div data-testid="entry-user" className="flex gap-3">
        <Gutter label="you" tone="text-doom-cyan" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] text-doom-hi">
          <Markdown text={entry.text} />
          {sessionId ? <MentionPreviews sessionId={sessionId} mentions={parseFileMentions(entry.text)} /> : null}
        </div>
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
        <span className="h-px flex-1 bg-doom-border-soft" />
        <span className="text-[10px] text-doom-faint">
          agent settled{entry.tools > 0 ? ` · ${entry.tools} tool${entry.tools === 1 ? '' : 's'}` : ''}
        </span>
        <span className="h-px flex-1 bg-doom-border-soft" />
      </div>
    );
  }

  if (entry.kind === 'queued') {
    return (
      <div data-testid="entry-queued" className="flex pl-[58px]">
        <span className="inline-flex items-center gap-2 self-start rounded border border-doom-border bg-doom-panel px-2.5 py-1.5 text-[10px] text-doom-dim">
          <span className="text-doom-cyan">&#8635;</span>
          queued follow-up: &quot;{entry.text}&quot;
        </span>
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
}

export function Timeline() {
  const session = useActiveSession((state) => state);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const scroller = useRef<HTMLDivElement>(null);
  // The transcript's height as of the last entry. Whether to follow the newest
  // line is decided against this rather than against a scroll event, because
  // an event fires after the fact and a fast run can grow the transcript
  // before the browser has reported the reader's scroll.
  const lastHeight = useRef(0);
  const [unread, setUnread] = useState(false);

  const atBottom = (element: HTMLDivElement, height: number): boolean =>
    element.scrollTop + element.clientHeight >= height - PINNED_THRESHOLD_PX;

  const jumpToLatest = (): void => {
    const element = scroller.current;
    if (!element) return;
    setUnread(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  };

  /** Reaching the bottom by hand is the same as never having left it. */
  const onScroll = (): void => {
    const element = scroller.current;
    if (element && atBottom(element, element.scrollHeight)) setUnread(false);
  };

  // A focus change starts at the bottom of the newly focused transcript.
  useEffect(() => {
    lastHeight.current = 0;
    setUnread(false);
  }, [activeId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Was the reader at the end before this entry made the transcript longer?
    const following = atBottom(element, lastHeight.current);
    lastHeight.current = element.scrollHeight;
    if (following) {
      element.scrollTop = element.scrollHeight;
      setUnread(false);
      return;
    }
    setUnread(true);
  }, [session.entries]);

  if (session.entries.length === 0) {
    return (
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
              <span className="text-doom-faint">&#8599;</span>
            </Button>
          ))}
        </div>
      </EmptyState>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="timeline"
        className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[26px] py-[22px]"
      >
        {session.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} sessionId={activeId} />
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
