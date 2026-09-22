import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { Drawer } from '../../src/components/Drawer';

type FocusEvent = { preventDefault: () => void };
const captured = vi.hoisted(() => ({
  props: undefined as
    | undefined
    | {
        onOpenAutoFocus: () => void;
        onCloseAutoFocus: (event: FocusEvent) => void;
      },
}));

// Radix owns the browser focus trap. Capture only our adapter callbacks for focused unit coverage.
vi.mock('radix-ui', async (original) => {
  const actual = await original<typeof import('radix-ui')>();
  return {
    ...actual,
    Dialog: {
      ...actual.Dialog,
      Portal: ({ children }: { children: ReactNode }) => children,
      Content: (props: {
        children: ReactNode;
        onOpenAutoFocus: () => void;
        onCloseAutoFocus: (event: FocusEvent) => void;
        className: string;
      }) => {
        captured.props = props;
        return <div className={props.className}>{props.children}</div>;
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  captured.props = undefined;
});

it('renders the requested side and an accessible title while keeping the content in one mount', () => {
  const html = renderToStaticMarkup(
    <Drawer open side="left" title="Sessions" onOpenChange={() => {}}>
      <nav>Navigation</nav>
    </Drawer>,
  );
  expect(html).toContain('left-0 border-r');
  expect(html).toContain('Sessions');
  expect(html.match(/<nav>/g)).toHaveLength(1);
});

it('restores focus to an external opener, but never focuses a detached element', () => {
  class Element {
    isConnected = true;
    focus = vi.fn();
  }
  const opener = new Element();
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', { activeElement: opener });
  const html = renderToStaticMarkup(
    <Drawer open side="right" title="Activity" showHeader={false} onOpenChange={() => {}}>
      Activity content
    </Drawer>,
  );
  expect(html).toContain('right-0 border-l');
  captured.props!.onOpenAutoFocus();
  const preventDefault = vi.fn();
  captured.props!.onCloseAutoFocus({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(opener.focus).toHaveBeenCalledOnce();
  opener.isConnected = false;
  captured.props!.onCloseAutoFocus({ preventDefault });
  expect(opener.focus).toHaveBeenCalledOnce();
  vi.stubGlobal('document', { activeElement: null });
  captured.props!.onOpenAutoFocus();
  captured.props!.onCloseAutoFocus({ preventDefault });
  expect(opener.focus).toHaveBeenCalledOnce();
});
