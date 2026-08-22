import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { colorStatus, statusText } from '../../src/services/statusLine.ts';

const theme = {
  fg: (color: string, text: string) => `${color}(${text})`,
  bold: (text: string) => `bold(${text})`,
} as unknown as Theme;

describe('status line', () => {
  it('omits the profile segment when none is selected', () => {
    expect(statusText('copilot', ['default'])).toBe('[copilot]:default');
    expect(statusText('copilot', ['default'], 'reviewer')).toBe('*reviewer*:[copilot]:default');
    expect(statusText('copilot', [])).toBe('[copilot]');
  });

  it('colours a pending switch differently from a settled one', () => {
    expect(colorStatus(theme, 'copilot', ['default'], undefined, false)).toContain('accent([copilot])');
    expect(colorStatus(theme, 'copilot', ['default'], undefined, true)).toContain('warning([copilot])');
    expect(colorStatus(theme, 'copilot', [], 'reviewer', false)).toContain('bold(*reviewer*)');
    expect(colorStatus(theme, 'copilot', [], undefined, false)).not.toContain('muted');
  });
});
