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

/** The frame, wearing the edge STATUS_EDGE names for the tone, so the two never drift apart. */
export const messageItemVariants = cva('overflow-hidden rounded-md border bg-doom-panel transition-colors', {
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
        className={cn(messageItemVariants({ tone }), className)}
        {...props}
      >
        {typeof children === 'function' ? children(state) : children}
      </div>
    </MessageItemContext.Provider>
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

/** The title row: label, summary, the tone's badge, and the expand toggle when the item is expandable. */
export function MessageItemHeader({ className, title, badge, children, ...props }: MessageItemHeaderProps) {
  const { tone, expandable, expanded, toggle } = useMessageItem();
  const label = badge === undefined ? STATUS_LABEL[tone] : badge;
  return (
    <div
      data-slot="message-item-header"
      className={cn('flex min-h-8 items-center gap-2 px-[11px] text-[11px] text-doom-dim', className)}
      {...props}
    >
      <span className="shrink-0 font-bold text-doom-hi">{title}</span>
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
    },
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
