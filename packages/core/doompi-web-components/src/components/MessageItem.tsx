import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, createContext, type ReactNode, useContext, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';
import { STATUS_EDGE, StatusBadge, type StatusTone } from './StatusBadge.tsx';

/**
 * The message item: the timeline card a tool call, a run, or a notice sits
 * in. The item owns its outcome tone and its expand state; the header, body,
 * and status parts read both from it, so a card composes the parts and never
 * threads `expanded` by hand. A tool message in a web plugin is built from
 * this, and so is the cockpit's own fallback item, which is what keeps them
 * looking alike.
 */

export interface MessageItemState {
  tone: StatusTone;
  /** Whether the header offers the toggle; an item that hides nothing offers none. */
  expandable: boolean;
  expanded: boolean;
  toggle: () => void;
}

const MessageItemContext = createContext<MessageItemState>({
  tone: 'neutral',
  expandable: false,
  expanded: false,
  toggle: () => undefined,
});

/** The enclosing item's state, for a part that lives deeper than the item's render prop. */
export function useMessageItem(): MessageItemState {
  return useContext(MessageItemContext);
}

/**
 * The group an item is a row of, or null for an item that is a card of its
 * own. A row drops the frame the group already draws and keeps its tone as an
 * edge down its left side, and it stops repeating what the group's header has
 * said once: the tool's name, and an outcome the whole run shares.
 */
const MessageItemGroupContext = createContext<{ tone: StatusTone } | null>(null);

/** The frame, wearing the edge STATUS_EDGE names for the tone, so the two never drift apart. */
export const messageItemVariants = cva('overflow-hidden rounded-md border bg-doom-panel transition-colors', {
  variants: { tone: STATUS_EDGE },
  defaultVariants: { tone: 'neutral' },
});

/** The same tone as a row: no card, one coloured edge, and the group's separators between rows. */
export const messageItemRowVariants = cva('overflow-hidden border-l-2 transition-colors', {
  variants: { tone: STATUS_EDGE },
  defaultVariants: { tone: 'neutral' },
});

export interface MessageItemProps
  extends Omit<ComponentProps<'div'>, 'children'>, VariantProps<typeof messageItemVariants> {
  /** Whether the header offers the expand toggle. A toggle that reveals nothing reads as broken, so the card decides. */
  expandable?: boolean;
  defaultExpanded?: boolean;
  /** Controlled mode; pair with onExpandedChange. Omit it and the item keeps its own state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Plain content, or a function of the item's state for a card that picks its lines by `expanded`. */
  children?: ReactNode | ((state: MessageItemState) => ReactNode);
}

export function MessageItem({
  className,
  tone,
  expandable = false,
  defaultExpanded = false,
  expanded,
  onExpandedChange,
  children,
  ...props
}: MessageItemProps) {
  const [own, setOwn] = useState(defaultExpanded);
  const group = useContext(MessageItemGroupContext);
  const grouped = group !== null;
  const current = expanded ?? own;
  const state: MessageItemState = {
    tone: tone ?? 'neutral',
    expandable,
    expanded: current,
    toggle: () => {
      const next = !current;
      if (expanded === undefined) setOwn(next);
      onExpandedChange?.(next);
    },
  };
  return (
    <MessageItemContext.Provider value={state}>
      <div
        data-slot="message-item"
        data-expanded={current}
        data-grouped={grouped}
        className={cn(grouped ? messageItemRowVariants({ tone }) : messageItemVariants({ tone }), className)}
        {...props}
      >
        {typeof children === 'function' ? children(state) : children}
      </div>
    </MessageItemContext.Provider>
  );
}

export interface MessageItemGroupProps
  extends Omit<ComponentProps<'div'>, 'title'>, VariantProps<typeof messageItemVariants> {
  /** The bold label at the left of the group header: the tool the run belongs to. */
  title: ReactNode;
  /** The line beside it, such as how many calls the group holds. */
  summary?: ReactNode;
  /** The badge text; defaults to the tone's label, null hides the badge. */
  badge?: ReactNode | null;
  children?: ReactNode;
}

/**
 * One frame around a run of items that belong together.
 *
 * A transcript that calls the same tool five times in a row is five identical
 * frames, five gutter labels and five gaps, and the repetition reads louder
 * than the commands do. The group draws the frame once and each item inside it
 * becomes a row: same header, same expand, no card of its own. The tone still
 * belongs to the row, as an edge, so a failure in the middle of a run is not
 * flattened into the group's own outcome.
 */
export function MessageItemGroup({
  className,
  tone,
  title,
  summary,
  badge,
  children,
  ...props
}: MessageItemGroupProps) {
  const label = badge === undefined ? STATUS_LABEL[tone ?? 'neutral'] : badge;
  return (
    <MessageItemGroupContext.Provider value={{ tone: tone ?? 'neutral' }}>
      <div data-slot="message-item-group" className={cn(messageItemVariants({ tone }), className)} {...props}>
        <div className="flex min-h-8 items-center gap-2 border-doom-border-soft border-b px-[11px] text-[11px] text-doom-dim">
          <span className="shrink-0 font-bold text-doom-hi">{title}</span>
          <span className="min-w-0 flex-1 truncate text-doom-faint">{summary}</span>
          {label !== null && label !== '' ? <StatusBadge tone={tone ?? 'neutral'}>{label}</StatusBadge> : null}
        </div>
        <div className="flex flex-col divide-y divide-doom-border-soft">{children}</div>
      </div>
    </MessageItemGroupContext.Provider>
  );
}

/** The tone a tool call's item wears: running while the tool runs, then its outcome. */
export function toolTone(state: { running: boolean; isError: boolean }): StatusTone {
  return state.running ? 'running' : state.isError ? 'error' : 'ok';
}

/** The badge text a tone reads as when the header is not told otherwise; empty hides the badge. */
export const STATUS_LABEL: Readonly<Record<StatusTone, string>> = {
  neutral: '',
  running: 'RUNNING',
  ok: 'OK',
  error: 'ERROR',
  info: 'INFO',
  accent: 'NOTE',
};

export interface MessageItemHeaderProps extends Omit<ComponentProps<'div'>, 'title'> {
  /** The bold label at the left: the tool name. */
  title: ReactNode;
  /** The badge text; defaults to the tone's label, null hides the badge. */
  badge?: ReactNode | null;
  /** The summary beside the title; it gets the remaining width. */
  children?: ReactNode;
}

/** Inside a group these two are the quiet outcome: the group's header has already said it. */
const SILENT_IN_GROUP: ReadonlySet<StatusTone> = new Set<StatusTone>(['ok', 'neutral']);

/**
 * The title row: label, summary, the tone's badge, and the expand toggle when
 * the item is expandable.
 *
 * A row inside a group says less. The group's header has already named the
 * tool and stated the run's outcome, so the row drops its title and speaks up
 * only when something went wrong or is still going: five OK badges down a run
 * of five are noise, and the one ERROR among them is the point.
 */
export function MessageItemHeader({ className, title, badge, children, ...props }: MessageItemHeaderProps) {
  const { tone, expandable, expanded, toggle } = useMessageItem();
  const group = useContext(MessageItemGroupContext);
  const defaultLabel = group !== null && SILENT_IN_GROUP.has(tone) ? null : STATUS_LABEL[tone];
  const label = badge === undefined ? defaultLabel : badge;
  return (
    <div
      data-slot="message-item-header"
      className={cn('flex min-h-8 items-center gap-2 px-[11px] text-[11px] text-doom-dim', className)}
      {...props}
    >
      {group === null ? <span className="shrink-0 font-bold text-doom-hi">{title}</span> : null}
      <div data-slot="message-item-summary" className="flex min-w-0 flex-1 items-center gap-2">
        {children}
      </div>
      {label !== null && label !== '' ? (
        <StatusBadge tone={tone} data-testid="tool-status">
          {label}
        </StatusBadge>
      ) : null}
      {expandable ? (
        <Button
          variant="ghost"
          size="icon"
          data-testid="tool-expand"
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse' : 'expand'}
          onClick={toggle}
          className="text-doom-faint hover:text-doom-blue"
        >
          {expanded ? <ChevronUpIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </Button>
      ) : null}
    </div>
  );
}

/** The recessed body under the header. */
export function MessageItemBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-item-body"
      className={cn('border-t border-doom-border-soft bg-doom-deep px-3 py-2 text-[11px] text-doom-dim', className)}
      {...props}
    />
  );
}

/** The glyph a tone reads as in a status line. */
export const STATUS_GLYPH: Readonly<Record<StatusTone, string>> = {
  neutral: '…',
  running: '◐',
  ok: '✓',
  error: '✗',
  info: '●',
  accent: '●',
};

export const messageItemStatusVariants = cva('shrink-0', {
  variants: {
    tone: {
      neutral: 'text-doom-faint',
      running: 'text-doom-yellow',
      ok: 'text-doom-green',
      error: 'text-doom-red',
      info: 'text-doom-blue',
      accent: 'text-doom-magenta',
    } satisfies Record<StatusTone, string>,
  },
  defaultVariants: { tone: 'neutral' },
});

export interface MessageItemStatusProps extends ComponentProps<'span'>, VariantProps<typeof messageItemStatusVariants> {
  /** Replaces the tone's glyph. */
  glyph?: string;
  /** Renders as a button that expands the item: the "N more line(s)" hint. Only className carries over. */
  expands?: boolean;
}

/** The one-line status under a body: `◐ running`, `✗ failed`, `✓ done`, or the hint that more is hidden. */
export function MessageItemStatus({
  className,
  tone,
  glyph,
  expands = false,
  children,
  ...props
}: MessageItemStatusProps) {
  const { toggle } = useMessageItem();
  const content = (
    <>
      <span className={messageItemStatusVariants({ tone })}>{glyph ?? STATUS_GLYPH[tone ?? 'neutral']}</span>
      <span>{children}</span>
    </>
  );
  if (expands) {
    return (
      <button
        type="button"
        data-slot="message-item-status"
        data-testid="tool-more"
        onClick={toggle}
        className={cn('flex cursor-pointer items-center gap-1.5 text-doom-faint hover:text-doom-blue', className)}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-slot="message-item-status"
      className={cn('flex items-center gap-1.5 text-doom-faint', className)}
      {...props}
    >
      {content}
    </span>
  );
}
