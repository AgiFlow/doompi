import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyntaxLine } from '../../src/components/SyntaxText.tsx';

describe('syntax line presentation', () => {
  it('renders escaped plain text while highlighting is unavailable', () => {
    expect(renderToStaticMarkup(<SyntaxLine text="<pending>" className="source" />)).toBe(
      '<span class="source">&lt;pending&gt;</span>',
    );
  });

  it('renders styled and unstyled spans instead of stale fallback text', () => {
    const out = renderToStaticMarkup(
      <SyntaxLine
        text="stale"
        spans={[{ text: 'const', token: 'keyword' }, { text: ' x = ' }, { text: '<value>', token: 'string' }]}
      />,
    );
    expect(out).toContain('style="color:var(--doom-magenta)"');
    expect(out).toContain('<span> x = </span>');
    expect(out).toContain('&lt;value&gt;');
    expect(out).not.toContain('stale');
  });

  it('treats an empty highlighted line as empty rather than falling back', () => {
    expect(renderToStaticMarkup(<SyntaxLine text="stale" spans={[]} />)).toBe('<span></span>');
  });
});
