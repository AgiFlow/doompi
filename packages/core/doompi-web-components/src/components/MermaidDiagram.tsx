import { useEffect, useId, useState } from 'react';
import { renderMermaid } from '../lib/mermaidDiagram.ts';
import { SyntaxText } from './SyntaxText.tsx';

/**
 * A mermaid fence, drawn.
 *
 * DESIGN PATTERNS:
 * - The source is the fallback, never a spinner or an error box. A diagram
 *   that has not loaded yet, a diagram that fails to parse and a diagram in a
 *   half-streamed message all show the text the author wrote, which stays
 *   useful on its own.
 * - The rendered markup is stored with the source it came from, so a message
 *   that grows never paints the previous frame's picture over new text.
 *
 * AVOID:
 * - Rendering at module scope or during render: mermaid measures text in the
 *   document, so it only runs in an effect, in a browser.
 */

interface Drawn {
  source: string;
  svg: string;
}

export function MermaidDiagram({ code }: { code: string }) {
  // Mermaid puts the id in the DOM and in the SVG's own ids, so React's
  // colon-wrapped value has to lose its punctuation first.
  const id = `mermaid-${useId().replaceAll(/[^a-zA-Z0-9]/g, '')}`;
  const [drawn, setDrawn] = useState<Drawn | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void renderMermaid(id, code).then(
      (svg) => {
        if (live) setDrawn({ source: code, svg });
      },
      // Invalid syntax and a chunk that will not load are the same outcome
      // here: the block keeps showing its source.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, id]);

  if (drawn?.source !== code) return <SyntaxText text={code} className="text-doom-text" />;
  return (
    <div
      data-testid="mermaid-diagram"
      // Mermaid sanitises its own output under the strict security level set
      // in lib/mermaidDiagram.ts; this is the only way it hands back a figure.
      dangerouslySetInnerHTML={{ __html: drawn.svg }}
      className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
