import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Dot,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Kbd,
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
    expect(html(<Textarea bare />)).toContain('bg-transparent');
    expect(html(<Kbd>SPC</Kbd>)).toContain('<kbd');
    expect(html(<SectionLabel>sessions</SectionLabel>)).toContain('tracking-[0.18em]');
    expect(html(<Separator vertical />)).toContain('aria-orientation="vertical"');
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
