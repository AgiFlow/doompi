import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  cn,
  collapseLines,
  Dialog,
  DialogContent,
  DialogTitle,
  Dot,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Kbd,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  MessageLines,
  Panel,
  PanelBody,
  PanelHeader,
  Popover,
  PopoverTrigger,
  SectionLabel,
  Separator,
  Spinner,
  STATUS_EDGE,
  StatusBadge,
  StreamCursor,
  Textarea,
  toolTone,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from '../../src/exports/index.ts';

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe('cn', () => {
  it('joins conditionally and lets the last Tailwind conflict win', () => {
    const hidden = [] as string[];
    expect(cn('px-2', hidden.length > 0 && 'hidden', 'px-3')).toBe('px-3');
  });
});

describe('primitives', () => {
  it('draws a button from theme tokens only, defaulting to type=button', () => {
    const out = html(
      <Button variant="primary" size="sm">
        go
      </Button>,
    );
    expect(out).toContain('type="button"');
    expect(out).toContain('bg-doom-blue');
    expect(out).not.toMatch(/#[0-9a-f]{6}/i);
    expect(
      html(
        <Button asChild>
          <a href="/x">link</a>
        </Button>,
      ),
    ).toContain('<a');
  });

  it('badges, dots and status pills carry their tone', () => {
    expect(html(<Badge tone="green">ok</Badge>)).toContain('text-doom-green');
    expect(html(<Dot tone="yellow" pulse />)).toContain('animate-pulse');
    expect(html(<StatusBadge tone="running">running</StatusBadge>)).toContain('bg-doom-tint-yellow');
    expect(STATUS_EDGE.error).toBe('border-doom-edge-red');
  });

  it('fields, labels and layout pieces render', () => {
    expect(html(<Input placeholder="p" />)).toContain('placeholder="p"');
    expect(html(<Textarea variant="bare" />)).toContain('bg-transparent');
    expect(html(<Kbd>SPC</Kbd>)).toContain('<kbd');
    expect(html(<SectionLabel>sessions</SectionLabel>)).toContain('tracking-[0.18em]');
    expect(html(<Separator orientation="vertical" />)).toContain('data-orientation="vertical"');
    expect(html(<Spinner />)).toContain('animate-spin');
    expect(html(<StreamCursor />)).toContain('animate-doom-blink');
    expect(
      html(
        <Panel>
          <PanelHeader>h</PanelHeader>
          <PanelBody>b</PanelBody>
        </Panel>,
      ),
    ).toContain('bg-doom-deep');
    expect(
      html(
        <EmptyState title="nothing" description="yet">
          <Button>act</Button>
        </EmptyState>,
      ),
    ).toContain('nothing');
  });

  it('message items carry their tone, offer the toggle only when expandable, and share expanded with their parts', () => {
    const collapsed = html(
      <MessageItem tone="error" expandable data-testid="x">
        {({ expanded }) => (
          <>
            <MessageItemHeader title="bash">{expanded ? 'open' : 'closed'}</MessageItemHeader>
            <MessageItemBody>b</MessageItemBody>
          </>
        )}
      </MessageItem>,
    );
    expect(collapsed).toContain('border-doom-edge-red');
    expect(collapsed).toContain('data-testid="x"');
    expect(collapsed).toContain('data-testid="tool-status"');
    expect(collapsed).toContain('ERROR');
    expect(collapsed).toContain('data-testid="tool-expand"');
    expect(collapsed).toContain('closed');
    expect(collapsed).toContain('bg-doom-deep');
    expect(collapsed).not.toMatch(/#[0-9a-f]{6}/i);

    const open = html(
      <MessageItem tone="ok" expandable defaultExpanded>
        {({ expanded }) => <MessageItemHeader title="read">{expanded ? 'open' : 'closed'}</MessageItemHeader>}
      </MessageItem>,
    );
    expect(open).toContain('open');
    expect(open).toContain('data-expanded="true"');

    const plain = html(
      <MessageItem tone="neutral">
        <MessageItemHeader title="x" badge={null}>
          summary
        </MessageItemHeader>
      </MessageItem>,
    );
    expect(plain).not.toContain('tool-expand');
    expect(plain).not.toContain('tool-status');
    expect(plain).toContain('summary');

    expect(html(<MessageItemStatus tone="running">running</MessageItemStatus>)).toContain('◐');
    expect(html(<MessageItemStatus tone="running">running</MessageItemStatus>)).toContain('text-doom-yellow');
    expect(html(<MessageItemStatus expands>3 more line(s)</MessageItemStatus>)).toContain('data-testid="tool-more"');
    expect(
      html(
        <MessageItemStatus glyph="●" tone="info">
          bg
        </MessageItemStatus>,
      ),
    ).toContain('text-doom-blue');
  });

  it('message lines and collapse follow the view logic', () => {
    const out = html(<MessageLines lines={[{ text: 'a', tone: 'success', bold: true, indent: true }]} />);
    expect(out).toContain('text-doom-green');
    expect(out).toContain('font-bold');
    expect(out).toContain('pl-4');
    expect(collapseLines(['a', 'b', 'c'], 2, false)).toEqual({ shown: ['a', 'b'], hidden: 1 });
    expect(collapseLines(['a', 'b', 'c'], 2, true)).toEqual({ shown: ['a', 'b', 'c'], hidden: 0 });
    expect(collapseLines(['a'], 2, false)).toEqual({ shown: ['a'], hidden: 0 });
    expect(toolTone({ running: true, isError: true })).toBe('running');
    expect(toolTone({ running: false, isError: true })).toBe('error');
    expect(toolTone({ running: false, isError: false })).toBe('ok');
  });

  it('overlays render their triggers while closed', () => {
    expect(
      html(
        <Dialog>
          <DialogContent>
            <DialogTitle>t</DialogTitle>
          </DialogContent>
        </Dialog>,
      ),
    ).toBe('');
    expect(
      html(
        <Popover>
          <PopoverTrigger>open</PopoverTrigger>
        </Popover>,
      ),
    ).toContain('open');
    expect(
      html(
        <DropdownMenu>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        </DropdownMenu>,
      ),
    ).toContain('menu');
    expect(
      html(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>tip</TooltipTrigger>
          </Tooltip>
        </TooltipProvider>,
      ),
    ).toContain('tip');
  });
});
