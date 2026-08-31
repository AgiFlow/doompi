import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';
import type { PresentedLine } from '../lib/hashlineView.ts';

/**
 * The anchored body shared by hashline results: a file heading per group, a
 * right-aligned line-number gutter, and a `>>` marker on grep matches. The
 * gutter width is a style, not a class, because it follows the widest number.
 */
export interface HashlineLinesProps extends ComponentProps<'div'> {
  lines: readonly PresentedLine[];
  /** Width of the line-number column, in characters, from `hashlineBody`. */
  gutter: number;
}

export function HashlineLines({ className, lines, gutter, ...props }: HashlineLinesProps) {
  // Bound to a name rather than written inline: this file ships as a scaffold
  // template too, and an inline style object opens with the same two braces
  // Liquid reads as an output tag, which fails to render.
  const gutterStyle = { width: `${gutter}ch` };
  return (
    <div data-slot="hashline-lines" className={cn('flex flex-col font-mono', className)} {...props}>
      {lines.map((line, index) => {
        if (line.type === 'file') {
          return (
            <span key={index} className="mt-1 truncate text-doom-faint first:mt-0">
              {line.path}
            </span>
          );
        }
        if (line.type === 'plain') {
          return (
            <span key={index} className="whitespace-pre-wrap break-words text-doom-dim">
              {line.text}
            </span>
          );
        }
        const { value } = line;
        return (
          <span key={index} className="flex gap-2">
            {value.marker !== undefined ? (
              <span className={`w-4 shrink-0 ${value.marker === 'match' ? 'text-doom-blue' : 'text-doom-faint'}`}>
                {value.marker === 'match' ? '>>' : ''}
              </span>
            ) : null}
            <span className="shrink-0 text-right text-doom-faint" style={gutterStyle}>
              {value.line}
            </span>
            <span
              className={`min-w-0 whitespace-pre-wrap break-words ${value.marker === 'match' ? 'text-doom-hi' : 'text-doom-text'}`}
            >
              {value.content}
            </span>
          </span>
        );
      })}
    </div>
  );
}
