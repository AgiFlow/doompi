import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolPathLink } from '../../src/components/ToolPathLink.tsx';

describe('tool path links', () => {
  it('keeps a path plain when the host cannot open it', () => {
    const out = renderToStaticMarkup(<ToolPathLink path="src/file.ts" />);
    expect(out).toContain('<span data-slot="tool-path" data-testid="tool-path"');
    expect(out).toContain('src/file.ts</span>');
    expect(out).not.toContain('<button');
  });

  it('renders an explicit button and forwards the host action without invoking it on render', () => {
    const onOpen = vi.fn();
    const element = ToolPathLink({
      path: 'src/<file>.ts',
      onOpen,
      className: 'custom-path',
      'data-testid': 'read-path',
    });
    const out = renderToStaticMarkup(element);
    expect(out).toContain('<button type="button"');
    expect(out).toContain('data-testid="read-path"');
    expect(out).toContain('title="open src/&lt;file&gt;.ts"');
    expect(out).toContain('custom-path');
    expect(onOpen).not.toHaveBeenCalled();
    expect(element.props.onClick).toBe(onOpen);
  });
});
