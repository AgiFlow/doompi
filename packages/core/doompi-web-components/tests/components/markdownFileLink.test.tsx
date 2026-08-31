import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/exports/index.ts';

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

describe('Markdown file links', () => {
  it('leaves inline code alone without a handler', () => {
    const out = html(<Markdown text="see `src/app.ts` for it" />);
    expect(out).toContain('<code');
    expect(out).not.toContain('markdown-file-link');
  });

  it('links only the inline code the handler claims', () => {
    const out = html(
      <Markdown
        text="`src/app.ts` uses `flex gap-3`"
        onFileLink={(text) => (text === 'src/app.ts' ? () => undefined : undefined)}
      />,
    );
    expect(out).toContain('data-testid="markdown-file-link"');
    expect(out).toContain('title="open src/app.ts"');
    // The class name the handler refused stays a plain code span.
    expect(out).toContain('flex gap-3</code>');
  });

  it('never turns a fenced block into a link', () => {
    const out = html(<Markdown text={['```', 'src/app.ts', '```'].join('\n')} onFileLink={() => () => undefined} />);
    expect(out).not.toContain('markdown-file-link');
  });
});
