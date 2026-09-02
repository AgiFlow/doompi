import { type ComponentProps, Fragment, useMemo } from 'react';
import { type AnsiSpan, ansiSpans } from '../lib/ansiSpans.ts';
import { cn } from '../lib/cn.ts';

/**
 * Terminal output with the colours it was written in.
 *
 * Both readers of terminal text render it the same way, so the mapping from a
 * span's attributes to classes lives here rather than in each of them: a
 * captured workflow screen is a line at a time, and a runner log is a block.
 * Parsing is synchronous and cheap; text with no escapes in it takes a path
 * that allocates nothing.
 *
 * DESIGN PATTERNS:
 * - Named colours arrive as theme classes from `ansiSpans`; only 256-colour
 *   and truecolour, which no token stands for, come through as a style.
 * - One element per line, so wrapping and selection behave as they do in a pre.
 *
 * AVOID:
 * - Carrying attributes across lines. A captured screen and a bounded log tail
 *   both start mid-stream.
 */

function spanClassName(span: AnsiSpan): string {
  return cn(
    span.className,
    span.bold === true && 'font-bold',
    span.faint === true && 'opacity-60',
    span.italic === true && 'italic',
    span.underline === true && 'underline',
    span.inverse === true && 'bg-doom-text text-doom-deep',
  );
}

function AnsiSpans({ spans }: { spans: readonly AnsiSpan[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <span
          key={index}
          className={spanClassName(span)}
          style={span.color === undefined ? undefined : { color: span.color }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

export interface AnsiLineProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** One line of terminal output, escapes and all. */
  line: string;
}

/** One line, for a caller that already lays out a screen row by row. */
export function AnsiLine({ line, className, ...props }: AnsiLineProps) {
  const spans = useMemo(() => ansiSpans(line), [line]);
  return (
    <span data-slot="ansi-line" className={className} {...props}>
      <AnsiSpans spans={spans} />
    </span>
  );
}

export interface AnsiTextProps extends Omit<ComponentProps<'pre'>, 'children'> {
  /** Terminal output, newline separated, escapes and all. */
  text: string;
}

/** A block of terminal output: a log tail, or anything else that arrives whole. */
export function AnsiText({ text, ...props }: AnsiTextProps) {
  const lines = useMemo(() => text.split('\n').map((line) => ansiSpans(line)), [text]);
  return (
    <pre data-slot="ansi-text" {...props}>
      {lines.map((spans, index) => (
        <Fragment key={index}>
          {index > 0 ? '\n' : null}
          <AnsiSpans spans={spans} />
        </Fragment>
      ))}
    </pre>
  );
}
