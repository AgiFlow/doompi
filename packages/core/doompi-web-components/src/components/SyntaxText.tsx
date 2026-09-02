import { type ComponentProps, Fragment, useEffect, useState } from 'react';
import { cn } from '../lib/cn.ts';
import type { GrammarKey } from '../lib/editorLanguage.ts';
import {
  detectGrammar,
  highlightToLines,
  type SyntaxLines,
  type SyntaxSpan,
  syntaxStyleOf,
} from '../lib/syntaxHighlight.ts';

/**
 * Read-only code with the editor's colours.
 *
 * Two shapes over one hook, because the cards need both: `SyntaxText` for a
 * block of code that owns its own element, and `SyntaxLine` for a card that
 * already renders a line at a time next to a gutter. Highlighting is
 * asynchronous, so both show the plain text first and swap in spans once the
 * grammar has loaded; a result that never highlights simply stays plain.
 *
 * DESIGN PATTERNS:
 * - Plain text is the fallback, never a spinner: colour is decoration.
 * - The hook keys on the text, so a streaming result re-highlights as it grows.
 *
 * AVOID:
 * - Highlighting one line at a time. A line is not a parse unit; pass the whole
 *   block to `useSyntaxLines` and render the line you want out of the result.
 */

export interface SyntaxQuery {
  /** The file the code came from, when the tool knows one. */
  path?: string | undefined;
  /** Skips detection when the caller already knows the grammar. */
  grammar?: GrammarKey | undefined;
}

/**
 * Colours `text`, or hands back undefined while that is still loading and for
 * anything with no grammar. Rendering the result is the caller's business.
 *
 * The finished spans are stored with the text they belong to, so text that has
 * changed since reads as plain during render rather than showing the previous
 * result's colours over the new lines.
 */
export function useSyntaxLines(text: string, query: SyntaxQuery = {}): SyntaxLines | undefined {
  const { path, grammar } = query;
  const key = grammar ?? detectGrammar({ path, text });
  const signature = `${key ?? ''}\u0000${text}`;
  const [done, setDone] = useState<{ signature: string; lines: SyntaxLines } | undefined>(undefined);

  useEffect(() => {
    if (key === undefined) return;
    let live = true;
    void highlightToLines(text, key).then(
      (result) => {
        if (live && result !== undefined) setDone({ signature, lines: result });
      },
      // A grammar chunk that fails to load leaves the plain text in place: the
      // card stays readable and the network failure is the browser's to report.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [text, key, signature]);

  return done?.signature === signature ? done.lines : undefined;
}

export interface SyntaxLineProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** The line's spans from `useSyntaxLines`, or undefined to show `text` plain. */
  spans?: readonly SyntaxSpan[] | undefined;
  text: string;
}

/** One line: coloured when its spans are in, the plain text until then. */
export function SyntaxLine({ spans, text, ...props }: SyntaxLineProps) {
  if (spans === undefined) return <span {...props}>{text}</span>;
  return (
    <span {...props}>
      {spans.map((span, index) => (
        <span key={index} style={syntaxStyleOf(span.token)}>
          {span.text}
        </span>
      ))}
    </span>
  );
}

export interface SyntaxTextProps extends Omit<ComponentProps<'pre'>, 'children'>, SyntaxQuery {
  text: string;
}

/** A block of code, wrapped rather than clipped, coloured when a grammar is known. */
export function SyntaxText({ className, text, path, grammar, ...props }: SyntaxTextProps) {
  const lines = useSyntaxLines(text, { path, grammar });
  const plain = text.split('\n');
  return (
    <pre
      data-slot="syntax-text"
      data-highlighted={lines !== undefined}
      className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono', className)}
      {...props}
    >
      {(lines ?? plain).map((entry, index) => (
        <Fragment key={index}>
          {index > 0 ? '\n' : null}
          <SyntaxLine
            spans={typeof entry === 'string' ? undefined : entry}
            text={typeof entry === 'string' ? entry : ''}
          />
        </Fragment>
      ))}
    </pre>
  );
}
