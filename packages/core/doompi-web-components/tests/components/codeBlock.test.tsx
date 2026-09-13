import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../../src/exports';

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

const fence = (language: string, ...lines: string[]): string => [`\`\`\`${language}`, ...lines, '```'].join('\n');

describe('Markdown fenced blocks', () => {
  it('renders a fence as a code block carrying its language', () => {
    const out = html(<Markdown text={fence('ts', 'const x = 1;')} />);
    expect(out).toContain('data-slot="code-block"');
    expect(out).toContain('data-language="ts"');
    expect(out).toContain('const x = 1;');
    // Colour arrives after the grammar chunk loads; the source is on screen first.
    expect(out).toContain('data-highlighted="false"');
  });

  it('offers a copy control on every block', () => {
    expect(html(<Markdown text={fence('', 'plain text')} />)).toContain('data-testid="copy-button"');
  });

  it('drops the trailing newline markdown adds to a fence', () => {
    expect(html(<Markdown text={fence('', 'one')} />)).not.toContain('one\n');
  });

  it('shows a mermaid fence as its source until the diagram renders', () => {
    const out = html(<Markdown text={fence('mermaid', 'graph TD;', '  A-->B;')} />);
    expect(out).toContain('data-language="mermaid"');
    expect(out).toContain('graph TD;');
    expect(out).not.toContain('mermaid-diagram');
  });

  it('keeps inline code out of the block treatment', () => {
    const out = html(<Markdown text="a `value` here" />);
    expect(out).not.toContain('data-slot="code-block"');
  });
});
