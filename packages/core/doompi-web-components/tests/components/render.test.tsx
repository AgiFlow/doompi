import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Checkbox,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapseLines,
  Dialog,
  DialogContent,
  DialogTitle,
  Dot,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  HashlineLines,
  Input,
  Kbd,
  Label,
  Markdown,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  MessageLines,
  NavTab,
  NavTabBadge,
  optionListHint,
  OptionList,
  optionMarker,
  OptionRow,
  Panel,
  PanelBody,
  PanelHeader,
  Popover,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupCard,
  RadioGroupItem,
  ScrollArea,
  SectionLabel,
  Select,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Spinner,
  STATUS_EDGE,
  StatusBadge,
  StreamCursor,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
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

  it('renders GitHub-flavored Markdown through the shared safe presentation', () => {
    const out = html(
      <Markdown
        text={[
          '# One',
          '## Two',
          '### Three',
          '#### Four',
          '',
          'Paragraph **bold** *italic* ~~gone~~ [link](https://example.com) `inline`.',
          '',
          '> quote',
          '',
          '- item',
          '',
          '1. first',
          '',
          '---',
          '',
          '| A | B |',
          '| - | - |',
          '| 1 | 2 |',
          '',
          '![alt](https://example.com/a.png)',
          '',
          '```ts',
          'const value = 1;',
          '```',
        ].join('\n')}
      />,
    );
    expect(out).toContain('<h1');
    expect(out).toContain('<h4');
    expect(out).toContain('<table');
    expect(out).toContain('<blockquote');
    expect(out).toContain('<del');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('<img');
    expect(out).toContain('const value = 1;');
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

  it('draws hashline results with a file heading, a gutter, and a match marker', () => {
    const out = html(
      <HashlineLines
        gutter={2}
        lines={[
          { type: 'file', path: 'src/a.ts' },
          { type: 'tagged', value: { line: 12, content: 'hit', marker: 'match' } },
          { type: 'tagged', value: { line: 13, content: 'near', marker: 'context' } },
          { type: 'plain', text: 'native row' },
        ]}
      />,
    );
    expect(out).toContain('src/a.ts');
    expect(out).toContain('&gt;&gt;');
    expect(out).toContain('width:2ch');
    expect(out).toContain('text-doom-hi');
    expect(out).toContain('native row');
  });

  it('lends its styling to another element wherever asChild is offered', () => {
    expect(
      html(
        <Badge asChild tone="violet">
          <a href="/x">chip</a>
        </Badge>,
      ),
    ).toContain('<a');
    expect(
      html(
        <StatusBadge asChild tone="ok">
          <a href="/x">pill</a>
        </StatusBadge>,
      ),
    ).toContain('<a');
    expect(
      html(
        <NavTab asChild active>
          <a href="/x">tab</a>
        </NavTab>,
      ),
    ).toContain('data-active="true"');
  });

  it('shows a spinner and refuses clicks while a button is loading', () => {
    const busy = html(
      <Button loading loadingLabel="saving">
        save
      </Button>,
    );
    expect(busy).toContain('animate-spin');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled');
    expect(busy).toContain('saving');
    // A labelled spinner is a live status; an unlabelled one stays decorative.
    expect(html(<Spinner />)).toContain('aria-hidden');
    expect(html(<Spinner label="loading" />)).toContain('role="status"');
  });

  it('offers the form controls a settings page needs', () => {
    expect(html(<Checkbox defaultChecked />)).toContain('data-state="checked"');
    expect(html(<Switch defaultChecked />)).toContain('data-state="checked"');
    expect(
      html(
        <RadioGroup defaultValue="a">
          <RadioGroupItem value="a" />
          <RadioGroupCard value="b">card</RadioGroupCard>
        </RadioGroup>,
      ),
    ).toContain('role="radiogroup"');
    expect(html(<Label htmlFor="x">name</Label>)).toContain('for="x"');
    expect(
      html(
        <Select>
          <SelectTrigger>
            <SelectValue placeholder="pick" />
          </SelectTrigger>
        </Select>,
      ),
    ).toContain('pick');
    expect(html(<Progress value={40} />)).toContain('role="progressbar"');
    expect(html(<Skeleton className="h-4" />)).toContain('animate-pulse');
    expect(
      html(
        <Avatar>
          <AvatarFallback>vn</AvatarFallback>
        </Avatar>,
      ),
    ).toContain('vn');
  });

  it("draws an option list whose rows are options and whose cursor is the surface's", () => {
    const out = html(
      <OptionList
        options={['first', 'second']}
        cursor={1}
        onCursorChange={() => undefined}
        onSelect={() => undefined}
        testIdPrefix="option"
      />,
    );
    expect(out).toContain('role="listbox"');
    expect(out).toContain('data-testid="options"');
    expect(out).toContain('data-testid="option-1"');
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain('bg-doom-tint-blue');
    expect(html(<OptionRow density="compact">row</OptionRow>)).toContain('role="option"');
    expect(optionMarker(0)).toBe('1');
    expect(optionMarker(9)).toBe('·');
    expect(optionListHint(3)).toContain('1-9 select');
    expect(optionListHint(30)).toContain('jump');
  });

  it('stacks tabs, sections and scroll surfaces', () => {
    expect(
      html(
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">one</TabsTrigger>
          </TabsList>
        </Tabs>,
      ),
    ).toContain('role="tab"');
    expect(html(<NavTabBadge active>3</NavTabBadge>)).toContain('bg-doom-blue');
    expect(
      html(
        <Accordion type="single" collapsible defaultValue="a">
          <AccordionItem value="a">
            <AccordionTrigger>head</AccordionTrigger>
            <AccordionContent>body</AccordionContent>
          </AccordionItem>
        </Accordion>,
      ),
    ).toContain('head');
    expect(html(<ScrollArea className="h-10">scrolled</ScrollArea>)).toContain('scrolled');
    expect(
      html(
        <Collapsible defaultOpen>
          <CollapsibleTrigger>toggle</CollapsibleTrigger>
          <CollapsibleContent>folded</CollapsibleContent>
        </Collapsible>,
      ),
    ).toContain('folded');
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
        <Sheet>
          <SheetTrigger>detail</SheetTrigger>
          <SheetContent>
            <SheetTitle>t</SheetTitle>
          </SheetContent>
        </Sheet>,
      ),
    ).toContain('detail');
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
