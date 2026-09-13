import type { UserMessageActionRunContext, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  ChevronDownIcon,
  EmptyState,
  ExternalLinkIcon,
  MessageItemGroup,
  QuoteIcon,
  RewindIcon,
  Separator,
  StreamCursor,
  UserIcon,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Store } from '@tanstack/store';
import { Fragment, memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { fileTabForPath, useActivityGroups, useFileLinks } from '../../lib/composition';
import { parseFileMentions } from '../../lib/fileMentions';
import { pluginToolRenderer, pluginUserMessageActions } from '../../lib/pluginRegistry';
import { focusPrompt } from '../../lib/promptFocus';
import {
  isSupportedImageMimeType,
  type ProfileIdentity,
  type SessionState,
  type TimelineEntry,
  type ToolEntry,
} from '../../lib/sessionModel';
import { groupSummary, groupTone, timelineUnits } from '../../lib/timelineGroups';
import { appendComposerQuote } from '../../stores/composerStore';
import { sessionsStore } from '../../stores/sessionsStore';
import {
  requestOlderHistory,
  requestNewerHistory,
  requestLatestHistory,
  rewindToMessage,
  sessionStoreFor,
  submitMessage,
  useActiveSession,
} from '../../stores/sessionStore';
import { openTransientTab } from '../../stores/transientTabsStore';
import { useOpenTab } from '../../stores/useOpenTab';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps';
import { useWebPluginRegistry } from '../../stores/useWebPluginRegistry';
import { MentionPreviews } from './MentionPreviews';
import { MessageMarkdown, type MessageFileLinkHandler } from './MessageMarkdown';
import { ToolCard } from './ToolCard';

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

function noticeHref(line: string): string | null {
  if (/\s/u.test(line) || !/^https?:\/\//i.test(line)) return null;

  try {
    const url = new URL(line);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

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
  return <span className={`shrink-0 text-xs font-bold ${placement} ${tone}`}>{label}</span>;
}

/** Two letters from a persona name, so a profile without an icon is still distinct. */
function personaInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0]?.slice(0, 2) ?? '');
  return letters.toUpperCase() || 'DP';
}

function SpeakerAvatar({ speaker, identity }: { speaker: 'assistant' | 'user'; identity?: ProfileIdentity | null }) {
  if (speaker === 'assistant') {
    // The icon arrives as a bounded data URL on the journalled identity entry,
    // so a persona without one, or with one that failed to load, still renders.
    const label = identity?.name ?? identity?.profile ?? 'DoomPi';
    const fallback = identity ? personaInitials(label) : 'DP';
    return (
      <Avatar aria-label={label} className="h-8 w-8 border border-doom-border-soft bg-doom-deep p-1">
        <AvatarImage src={identity?.icon ?? '/favicon.svg'} alt="" />
        <AvatarFallback className="text-doom-magenta">{fallback}</AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar aria-label="You" className="h-8 w-8 self-end border border-doom-border-soft bg-doom-panel p-1 sm:self-auto">
      <AvatarFallback className="text-doom-cyan">
        <UserIcon aria-hidden="true" className="h-5 w-5" />
      </AvatarFallback>
    </Avatar>
  );
}

type UserMessageActions = ReturnType<typeof pluginUserMessageActions>;

function MessageActions({
  actions,
  disabled,
  onQuote,
  onRewind,
  userMessage,
}: {
  actions: UserMessageActions;
  disabled: boolean;
  onQuote: () => void;
  onRewind: () => void;
  userMessage?: UserMessageActionRunContext;
}) {
  return (
    <div
      data-testid="entry-actions"
      className="pointer-events-none absolute right-1 bottom-0 z-10 flex max-w-[calc(100%-0.5rem)] translate-y-1/2 flex-wrap justify-end gap-1 rounded-md border border-doom-border-soft bg-doom-panel p-0.5 opacity-0 shadow-sm transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
    >
      {userMessage
        ? actions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <Button
                key={`${action.pluginId}.${action.id}`}
                variant="subtle"
                size={ActionIcon ? 'icon' : 'sm'}
                data-testid="entry-plugin-action"
                aria-label={action.label}
                title={action.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => action.run(userMessage)}
                className={ActionIcon ? 'border-0 shadow-none' : 'h-6 border-0 px-2 text-xs shadow-none'}
              >
                {ActionIcon ? <ActionIcon aria-hidden={true} className="h-3 w-3" /> : action.label}
              </Button>
            );
          })
        : null}
      <Button
        variant="subtle"
        size="icon"
        data-testid="entry-rewind"
        aria-label="Rewind to message"
        title={disabled ? 'Wait for the current response before rewinding' : 'Rewind to message'}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRewind}
        className="border-0 shadow-none"
      >
        <RewindIcon aria-hidden="true" className="h-3 w-3" />
      </Button>
      <Button
        variant="subtle"
        size="icon"
        data-testid="entry-quote"
        aria-label="Quote message"
        title="Quote message"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onQuote}
        className="border-0 shadow-none"
      >
        <QuoteIcon aria-hidden="true" className="h-3 w-3" />
      </Button>
    </div>
  );
}
function ToolEntryRow({
  entry,
  slotProps,
  statuses,
}: {
  entry: Extract<TimelineEntry, { kind: 'tool' }>;
  slotProps: WebPluginSlotProps;
  statuses: Readonly<Record<string, string>>;
}) {
  const presentation = pluginToolRenderer(entry.name, statuses)?.timelinePresentation ?? 'tool';
  return (
    <div
      data-testid="entry-tool-row"
      data-tool-presentation={presentation}
      className="flex flex-col gap-1 sm:flex-row sm:gap-3"
    >
      {presentation === 'tool' ? <Gutter label="tool" tone="text-doom-faint" /> : null}
      <div className="min-w-0 flex-1">
        <ToolCard entry={entry} slotProps={slotProps} statuses={statuses} />
      </div>
    </div>
  );
}

/**
 * A run of calls to one tool, under one frame and one gutter label. The rows
 * inside are the same cards the tool renders on its own; the group only takes
 * their border, so each call still opens and closes by itself.
 */
function ToolGroupRow({
  name,
  entries,
  slotProps,
  statuses,
}: {
  name: string;
  entries: readonly ToolEntry[];
  slotProps: WebPluginSlotProps;
  statuses: Readonly<Record<string, string>>;
}) {
  return (
    <div
      data-testid="entry-tool-row"
      data-tool-presentation="tool"
      className="flex flex-col gap-1 sm:flex-row sm:gap-3"
    >
      <Gutter label="tool" tone="text-doom-faint" />
      <MessageItemGroup
        data-testid="entry-tool-group"
        data-tool-name={name}
        data-tool-count={entries.length}
        tone={groupTone(entries)}
        title={name}
        summary={`· ${groupSummary(entries)}`}
        className="min-w-0 flex-1"
      >
        {entries.map((entry) => (
          <ToolCard key={entry.id} entry={entry} slotProps={slotProps} statuses={statuses} />
        ))}
      </MessageItemGroup>
    </div>
  );
}
interface EntryProps {
  entry: TimelineEntry;
  onFileLink: MessageFileLinkHandler;
  pluginActions: UserMessageActions;
  sessionId: string | null;
  sessionIdentity: ProfileIdentity | null;
  sessionStreaming: boolean;
  slotProps: WebPluginSlotProps;
  toolStatuses: Readonly<Record<string, string>>;
}

const Entry = memo(function Entry({
  entry,
  onFileLink,
  pluginActions,
  sessionId,
  sessionIdentity,
  sessionStreaming,
  slotProps,
  toolStatuses,
}: EntryProps) {
  const quoteSource = useRef<HTMLDivElement>(null);
  const quoteMessage = (text: string): void => {
    const selection = window.getSelection();
    const source = quoteSource.current;
    const selected =
      source !== null &&
      selection !== null &&
      !selection.isCollapsed &&
      selection.anchorNode !== null &&
      selection.focusNode !== null &&
      source.contains(selection.anchorNode) &&
      source.contains(selection.focusNode)
        ? selection.toString()
        : text;
    const caret = appendComposerQuote(sessionId, selected);
    if (caret !== null) requestAnimationFrame(() => focusPrompt(caret));
  };

  if (entry.kind === 'user') {
    return (
      <div
        data-testid="entry-user"
        className="group/message flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:gap-3 sm:pl-10"
      >
        <div className="relative min-w-0 flex-1">
          <div
            ref={quoteSource}
            className="flex flex-col gap-2 rounded-md border border-doom-border-soft bg-doom-deep px-3.5 py-2.5 text-base text-doom-hi"
          >
            <MessageMarkdown onFileLink={onFileLink} text={entry.text} />
            {entry.images && entry.images.length > 0 ? (
              <div data-testid="user-attachments" className="flex flex-wrap gap-2">
                {entry.images
                  .filter((image) => isSupportedImageMimeType(image.mimeType))
                  .map((image, index) => (
                    <img
                      key={`${image.mimeType}:${image.data.slice(0, 24)}:${String(index)}`}
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={`Attachment ${String(index + 1)}`}
                      data-testid="user-attached-image"
                      className="h-auto max-h-80 max-w-full rounded-md object-contain"
                    />
                  ))}
              </div>
            ) : null}
            {sessionId ? (
              <MentionPreviews sessionId={sessionId} mentions={parseFileMentions(entry.text)} onFileLink={onFileLink} />
            ) : null}
          </div>
          <MessageActions
            actions={pluginActions}
            disabled={sessionStreaming}
            onQuote={() => quoteMessage(entry.text)}
            onRewind={() => rewindToMessage(entry.id, sessionId)}
            userMessage={
              sessionId !== null && entry.text.trim().length > 0
                ? { sessionId, messageId: entry.id, text: entry.text }
                : undefined
            }
          />
        </div>
        <SpeakerAvatar speaker="user" />
      </div>
    );
  }

  if (entry.kind === 'assistant') {
    return (
      <div
        data-testid="entry-assistant"
        data-streaming={entry.streaming}
        className="group/message flex flex-col gap-2 sm:flex-row sm:gap-3"
      >
        <SpeakerAvatar speaker="assistant" identity={entry.identity ?? sessionIdentity} />
        <div className="relative min-w-0 flex-1">
          <div className="flex flex-col gap-2">
            {entry.thinking ? (
              <div
                data-testid="entry-thinking"
                // Thinking stays quiet and neutral, even when its Markdown source
                // uses strong emphasis for status updates.
                className="text-sm font-normal text-doom-dim [&_p]:whitespace-pre-wrap [&_strong]:font-normal [&_strong]:text-doom-dim"
              >
                <MessageMarkdown onFileLink={onFileLink} text={entry.thinking} />
              </div>
            ) : null}
            <div ref={quoteSource} className="text-base text-doom-text">
              <MessageMarkdown onFileLink={onFileLink} text={entry.text} />
              {entry.streaming ? <StreamCursor /> : null}
            </div>
          </div>
          <MessageActions
            actions={pluginActions}
            disabled={sessionStreaming}
            onQuote={() => quoteMessage(entry.text)}
            onRewind={() => rewindToMessage(entry.id, sessionId)}
          />
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') return <ToolEntryRow entry={entry} slotProps={slotProps} statuses={toolStatuses} />;

  if (entry.kind === 'settled') {
    return (
      <div data-testid="entry-settled" className="flex items-center gap-3 sm:pl-14">
        <Separator className="flex-1" />
        <span className="text-xs text-doom-faint">
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
        className={`shrink-0 pt-0.5 text-xs font-bold sm:w-11 sm:text-right ${isError ? 'text-doom-red' : 'text-doom-faint'}`}
      >
        {isError ? '!' : '·'}
      </span>
      <p
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-sm ${isError ? 'text-doom-red' : 'text-doom-dim'}`}
      >
        {entry.text.split(/(\s+)/u).map((part, index) => {
          const href = noticeHref(part);
          return (
            <Fragment key={index}>
              {href === null ? (
                part
              ) : (
                <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {part}
                </a>
              )}
            </Fragment>
          );
        })}
      </p>
    </div>
  );
}, entriesEqual);

function entriesEqual(previous: EntryProps, next: EntryProps): boolean {
  if (previous.entry !== next.entry || previous.sessionId !== next.sessionId) return false;
  if (next.entry.kind === 'tool') {
    return previous.slotProps === next.slotProps && previous.toolStatuses === next.toolStatuses;
  }
  if (next.entry.kind === 'user') {
    return (
      previous.onFileLink === next.onFileLink &&
      previous.pluginActions === next.pluginActions &&
      previous.sessionStreaming === next.sessionStreaming
    );
  }
  if (next.entry.kind === 'assistant') {
    return (
      previous.onFileLink === next.onFileLink &&
      previous.sessionIdentity === next.sessionIdentity &&
      previous.sessionStreaming === next.sessionStreaming
    );
  }
  return true;
}

function BackgroundWorkNotice() {
  return (
    <output data-testid="background-work-notice" className="mt-auto flex shrink-0 justify-center px-3 pt-2 pb-3">
      <span className="max-w-lg rounded-md border border-doom-yellow/40 bg-doom-panel px-3 py-2 text-center text-xs leading-relaxed text-doom-yellow">
        Background work is still running. The agent will resume when results are ready.
      </span>
    </output>
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
  historyKey = sessionId,
  empty,
  testId = 'timeline',
  backgroundWorkActive = false,
  limit,
  compact = false,
}: {
  store: Store<SessionState>;
  sessionId: string | null;
  historyKey?: string | null;
  empty: ReactNode;
  testId?: string;
  backgroundWorkActive?: boolean;
  limit?: number;
  compact?: boolean;
}) {
  'use no memo';
  const entries = useStore(store, (state) => state.entries);
  const hasNewerHistory = useStore(store, (state) => state.hasNewerHistory);
  // Pi's protocol transcript carries no persona, and a history window taken from
  // the middle of a session carries no identity entry either, so an entry from
  // those paths has no stamp of its own. The fold's current persona is the honest
  // answer for one of them, and it corrects itself when the identity lands late,
  // which a stamp written at merge time cannot do.
  const sessionIdentity = useStore(store, (state) => state.profileIdentity);
  const sessionStreaming = useActiveSession((state) => state.streaming);
  const toolStatuses = useActiveSession((state) => state.statuses);
  const resolveFileLink = useFileLinks(sessionId);
  const openTab = useOpenTab();
  const registryRevision = useWebPluginRegistry();
  const slotProps = usePluginSlotProps(sessionId);
  const pluginActions = useMemo(() => {
    void registryRevision;
    return pluginUserMessageActions();
  }, [registryRevision]);
  const onFileLink = useCallback<MessageFileLinkHandler>(
    (label, explicit = false) => {
      if (sessionId === null) return undefined;
      const tab = explicit ? fileTabForPath(sessionId, label) : resolveFileLink(label);
      if (tab === undefined) return undefined;
      return () => {
        openTransientTab(sessionId, tab);
        openTab(tab.id);
      };
    },
    [openTab, resolveFileLink, sessionId],
  );
  const visibleEntries = useMemo(() => {
    const shown = entries.filter((entry) => entry.kind !== 'queued');
    return limit === undefined ? shown : shown.slice(-limit);
  }, [entries, limit]);
  // A tool that presents itself as a message has no frame to share, so only
  // the card-shaped ones are gathered into runs.
  const units = useMemo(() => {
    void registryRevision;
    return timelineUnits(
      visibleEntries,
      (name) => (pluginToolRenderer(name, toolStatuses)?.timelinePresentation ?? 'tool') === 'tool',
    );
  }, [registryRevision, toolStatuses, visibleEntries]);
  const scroller = useRef<HTMLDivElement>(null);
  const unitKey = useCallback(
    (index: number): string => {
      const unit = units[index]!;
      return unit.kind === 'group' ? `group-${unit.entries[0]?.id ?? ''}` : unit.entry.id;
    },
    [units],
  );
  // This component opts out of compiler memoization because the virtualizer is mutable.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: units.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: unitKey,
    initialRect: { width: 0, height: 800 },
  });
  // The transcript's height as of the last entry. Whether to follow the newest
  // line is decided against this rather than against a scroll event, because
  // an event fires after the fact and a fast run can grow the transcript
  // before the browser has reported the reader's scroll.
  const lastHeight = useRef(0);
  const lastLayoutEntries = useRef(visibleEntries);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  // Where the bottom of the transcript sat before a window was prepended.
  // Restoring against this is what keeps the reader's place: prepending grows
  // the scroll height above them, and the browser would otherwise leave the
  // viewport where it was and the content would appear to jump.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
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
    if (!requestLatestHistory(historyKey)) followLatest();
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
    if (
      !compact &&
      ((element.scrollTop <= PAGE_BACK_THRESHOLD_PX && requestOlderHistory(historyKey)) ||
        (bottom && requestNewerHistory(historyKey)))
    ) {
      following.current = false;
      const item = virtualizer.getVirtualItems().find((candidate) => candidate.end > element.scrollTop);
      if (item) anchor.current = { key: String(item.key), offset: element.scrollTop - item.start };
    }
  };

  /** Wheel input is explicit intent to leave the live tail. */
  const onWheel = (): void => {
    following.current = false;
  };

  // A different fold starts at the bottom of its transcript. The unread badge
  // is cleared during render so the new fold never paints the old fold's badge;
  // the scroll bookkeeping stays in the layout effect, where refs belong.
  const [shownStore, setShownStore] = useState(store);
  if (shownStore !== store) {
    setShownStore(store);
    setUnread(false);
  }
  useLayoutEffect(() => {
    lastHeight.current = 0;
    firstId.current = null;
    anchor.current = null;
    following.current = true;
  }, [store]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const entriesChanged = lastLayoutEntries.current !== visibleEntries;
    lastLayoutEntries.current = visibleEntries;
    // Registry/status regrouping can resize unchanged entries. A no-op regroup
    // must not manufacture unread activity for someone reading older content.
    if (!entriesChanged && element.scrollHeight === lastHeight.current) return;
    // A prepended window grew the transcript upwards; hold the reader where
    // they were by moving down by exactly what appeared above them.
    const held = anchor.current;
    const prepended =
      visibleEntries.length > 0 && firstId.current !== null && visibleEntries[0]?.id !== firstId.current;
    firstId.current = visibleEntries[0]?.id ?? null;
    if (held !== null && prepended) {
      anchor.current = null;
      const index = units.findIndex((_unit, position) => unitKey(position) === held.key);
      if (index >= 0) {
        const offset = virtualizer.getOffsetForIndex(index, 'start')?.[0];
        if (offset !== undefined) element.scrollTop = offset + held.offset;
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
  }, [units, visibleEntries, virtualizer, unitKey]);

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
          compact ? 'flex-1 overflow-y-auto px-2.5 py-2' : 'flex-1 overflow-y-auto px-2 py-4 sm:px-[26px] sm:py-[22px]'
        }
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const unit = units[row.index]!;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                  paddingBottom: compact ? 8 : 18,
                }}
              >
                {unit.kind === 'group' ? (
                  <ToolGroupRow name={unit.name} entries={unit.entries} slotProps={slotProps} statuses={toolStatuses} />
                ) : (
                  <Entry
                    entry={unit.entry}
                    onFileLink={onFileLink}
                    pluginActions={pluginActions}
                    sessionId={sessionId}
                    sessionIdentity={sessionIdentity}
                    sessionStreaming={sessionStreaming}
                    slotProps={slotProps}
                    toolStatuses={toolStatuses}
                  />
                )}
              </div>
            );
          })}
        </div>
        {backgroundWorkActive ? <BackgroundWorkNotice /> : null}
      </div>
      {(unread || hasNewerHistory) && !compact ? (
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
