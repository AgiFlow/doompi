import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

const TOOL_BADGE_COLOR: ThemeColor = 'mdHeading';
const TOOL_PURPOSE_COLOR: ThemeColor = 'accent';

/** Shared width-aware call surface with the standard one-column Doom inset. */
export class DoomToolCall implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const contentWidth = Math.max(1, width - 2);
    return wrapTextWithAnsi(this.text, contentWidth).map((line) => ` ${line}`);
  }

  invalidate(): void {
    // Call text is immutable and reflows from the current width on every render.
  }
}

/** Reusable neutral shell around an arbitrary Doom tool result component. */
export class DoomToolResultFrame implements Component {
  constructor(
    private content: Component,
    private readonly theme: Theme,
  ) {}

  setContent(content: Component): void {
    this.content = content;
  }

  getContent(): Component {
    return this.content;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 3) return this.content.render(width);

    const contentWidth = width - 2;
    const lines = this.content.render(contentWidth).map((line) => ` ${line}`);
    if (lines.length === 0) return [];

    const divider = this.theme.fg('borderMuted', '─'.repeat(contentWidth));
    return [` ${divider}`, ...lines, ''];
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

/** Recover the inner result component from a frame returned on a previous pass. */
export function previousDoomToolResult(component: Component | undefined): Component | undefined {
  return component instanceof DoomToolResultFrame ? component.getContent() : undefined;
}

/** Reuse a previous result frame while replacing the component inside it. */
export function frameDoomToolResult(content: Component, theme: Theme, previous: Component | undefined): Component {
  if (previous instanceof DoomToolResultFrame) {
    previous.setContent(content);
    return previous;
  }
  return new DoomToolResultFrame(content, theme);
}

export interface DoomToolResultOptions {
  wrap?: boolean;
  trailingBlank?: boolean;
}

/** Neutral self-owned result frame for compact custom tools. */
export class DoomToolResult implements Component {
  constructor(
    private readonly lines: readonly string[],
    private readonly theme: Theme,
    private readonly options: DoomToolResultOptions = {},
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 3) return this.lines.map((line) => truncateToWidth(line, width, '…'));

    const contentWidth = width - 2;
    const content = this.options.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : this.lines.map((line) => truncateToWidth(line, contentWidth, '…'));
    const divider = this.theme.fg('borderMuted', '─'.repeat(contentWidth));
    const rendered = [divider, ...content].map((line) => ` ${line}`);
    if (this.options.trailingBlank !== false) rendered.push('');
    return rendered;
  }

  invalidate(): void {
    // Result text is immutable and reflows from the current width on every render.
  }
}

/** Doom-style inverse badge used to identify every self-rendered tool. */
export function renderToolBadge(label: string, theme: Theme): string {
  return theme.inverse(theme.bold(theme.fg(TOOL_BADGE_COLOR, ` ${label.toUpperCase()} `)));
}

/** Keep the tool identity visually separate from its path, command, or action. */
export function renderToolHeading(
  label: string,
  purpose: string,
  theme: Theme,
  purposeColor: ThemeColor = TOOL_PURPOSE_COLOR,
): string {
  const badge = renderToolBadge(label, theme);
  return purpose.length > 0 ? `${badge} ${theme.fg(purposeColor, purpose)}` : badge;
}
