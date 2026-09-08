import { fenceGrammarOf, fenceLanguageOf, MERMAID_LANGUAGE } from '../lib/fenceGrammar.ts';
import { CopyButton } from './CopyButton.tsx';
import { MermaidDiagram } from './MermaidDiagram.tsx';
import { SyntaxText } from './SyntaxText.tsx';

/**
 * A fenced code block: coloured, copyable, and a picture when it is mermaid.
 *
 * DESIGN PATTERNS:
 * - The fence's own word picks the grammar, and an unknown word means plain
 *   text rather than a guess at the wrong language.
 * - Colour and the diagram both arrive asynchronously, so the block always has
 *   the source on screen from the first frame of a streaming reply.
 *
 * AVOID:
 * - Reading the language anywhere but the fence. A block in a message has no
 *   path, and guessing from the body colours prose as code.
 */

export interface CodeBlockProps {
  /** The block's source, without the fence lines. */
  text: string;
  /** The `language-*` class react-markdown puts on the inner <code>. */
  className?: string | undefined;
}

export function CodeBlock({ text, className }: CodeBlockProps) {
  const language = fenceLanguageOf(className);
  const body =
    language === MERMAID_LANGUAGE ? (
      <MermaidDiagram code={text} />
    ) : (
      <SyntaxText
        text={text}
        grammar={fenceGrammarOf(language)}
        className="overflow-x-auto text-sm leading-relaxed text-doom-text"
      />
    );
  return (
    <div
      data-slot="code-block"
      data-language={language ?? ''}
      className="relative rounded border border-doom-border bg-doom-deep p-2.5"
    >
      {body}
      <CopyButton text={text} className="absolute top-1.5 right-1.5" />
    </div>
  );
}
