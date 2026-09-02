import { type ComponentProps, useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { type HashlineGroup, hashlineGroups, hashlineGroupsKey } from '../lib/hashlineHighlight.ts';
import type { PresentedLine } from '../lib/hashlineView.ts';
import { detectGrammar, highlightToLines, type SyntaxSpan } from '../lib/syntaxHighlight.ts';
import { SyntaxLine } from './SyntaxText.tsx';

/**
 * The anchored body shared by hashline results: a file heading per group, a
 * right-aligned line-number gutter, and a `>>` marker on grep matches. The
 * gutter width is a style, not a class, because it follows the widest number.
 *
 * The anchored lines are coloured with the editor's grammars when the body
 * names a file, or when `path` names one for a result that does not. Colour
 * arrives a frame or two late and never blocks the text: an unhighlighted body
 * is the same body without the colours.
 */
export interface HashlineLinesProps extends ComponentProps<'div'> {
  lines: readonly PresentedLine[];
  /** Width of the line-number column, in characters, from `hashlineBody`. */
  gutter: number;
  /** The file a body of bare anchored lines came from, for highlighting. */
  path?: string | undefined;
}

const NO_SPANS: ReadonlyMap<number, readonly SyntaxSpan[]> = new Map();

/**
 * Spans per presented-line index, once every file's run has parsed. The result
 * is stored with the body it belongs to, so a body that has changed since
 * reads as plain rather than wearing the previous body's colours.
 */
function useHashlineSpans(groups: readonly HashlineGroup[]): ReadonlyMap<number, readonly SyntaxSpan[]> {
  const key = hashlineGroupsKey(groups);
  const [done, setDone] = useState<{ key: string; spans: ReadonlyMap<number, readonly SyntaxSpan[]> } | undefined>(
    undefined,
  );

  useEffect(() => {
    let live = true;
    const next = new Map<number, readonly SyntaxSpan[]>();
    const work = groups.map(async (group) => {
      const grammar = detectGrammar({ path: group.path, text: group.text });
      if (grammar === undefined) return;
      const highlighted = await highlightToLines(group.text, grammar);
      if (highlighted === undefined) return;
      for (const [offset, index] of group.indices.entries()) {
        const line = highlighted[offset];
        if (line !== undefined) next.set(index, line);
      }
    });
    // One state write for the whole body, so a many-file grep result does not
    // repaint once per file. A grammar that fails to load leaves its run plain.
    void Promise.allSettled(work).then(() => {
      if (live && next.size > 0) setDone({ key, spans: next });
    });
    return () => {
      live = false;
    };
    // The groups are rebuilt every render; their key is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return done?.key === key ? done.spans : NO_SPANS;
}

export function HashlineLines({ className, lines, gutter, path, ...props }: HashlineLinesProps) {
  const groups = useMemo(() => hashlineGroups(lines, path), [lines, path]);
  const spans = useHashlineSpans(groups);
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
            <SyntaxLine
              spans={spans.get(index)}
              text={value.content}
              className={`min-w-0 whitespace-pre-wrap break-words ${value.marker === 'match' ? 'text-doom-hi' : 'text-doom-text'}`}
            />
          </span>
        );
      })}
    </div>
  );
}
