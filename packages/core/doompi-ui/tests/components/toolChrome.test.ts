import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  DoomToolCall,
  DoomToolResult,
  DoomToolResultFrame,
  frameDoomToolResult,
  previousDoomToolResult,
  renderToolBadge,
  renderToolHeading,
} from '../../src/tui/toolChrome.ts';

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
  inverse: (text: string) => `<inverse>${text}</inverse>`,
} as unknown as Theme;

describe('shared Doom tool chrome', () => {
  it('renders an uppercase inverse badge without square brackets', () => {
    const badge = renderToolBadge('read', theme);

    expect(badge).toBe('<inverse><bold><mdHeading> READ </mdHeading></bold></inverse>');
    expect(badge).not.toContain('[');
  });

  it('keeps purpose styling separate and applies the standard inset', () => {
    const heading = renderToolHeading('edit', 'src/index.ts', theme);
    const [line] = new DoomToolCall(heading).render(200);

    expect(line).toBe(' <inverse><bold><mdHeading> EDIT </mdHeading></bold></inverse> <accent>src/index.ts</accent>');
  });

  it('frames result content with width-aware wrapping and blank-line control', () => {
    const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    const clipped = new DoomToolResult(['abcdef'], plainTheme, { trailingBlank: false });
    const wrapped = new DoomToolResult(['abcdef'], plainTheme, { wrap: true });

    const clippedLines = clipped.render(5);
    expect(clippedLines).toHaveLength(2);
    expect(clippedLines[0]).toBe(' ───');
    expect(clippedLines[1]).toContain(' ab');
    expect(clippedLines[1]).toContain('…');

    const wrappedLines = wrapped.render(5);
    expect(wrappedLines).toHaveLength(4);
    expect(wrappedLines[0]).toBe(' ───');
    expect(wrappedLines[1]).toContain(' abc');
    expect(wrappedLines[2]).toContain(' def');
    expect(wrappedLines[3]).toBe('');

    const [narrowLine] = clipped.render(2);
    expect(narrowLine).toContain('a');
    expect(narrowLine).toContain('…');
    expect(clipped.render(0)).toEqual([]);
  });

  it('reuses a generic result frame while replacing its inner component', () => {
    const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    const firstContent = new Text('first', 0, 0);
    const firstFrame = frameDoomToolResult(firstContent, plainTheme, undefined);

    expect(firstFrame).toBeInstanceOf(DoomToolResultFrame);
    expect(previousDoomToolResult(firstFrame)).toBe(firstContent);
    expect(firstFrame.render(20).map((line) => line.trimEnd())).toEqual([' ──────────────────', ' first', '']);

    const nextContent = new Text('next', 0, 0);
    const nextFrame = frameDoomToolResult(nextContent, plainTheme, firstFrame);
    expect(nextFrame).toBe(firstFrame);
    expect(previousDoomToolResult(nextFrame)).toBe(nextContent);
    expect(nextFrame.render(20).map((line) => line.trimEnd())).toEqual([' ──────────────────', ' next', '']);
    expect(previousDoomToolResult(nextContent)).toBeUndefined();
  });
});
