import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  abbreviateHome,
  type BashResultDetails,
  collapseCommand,
  formatBashCommand,
  formatBashFlags,
  formatResultSummary,
  renderBashCall,
  renderBashResult,
  truncateMiddle,
} from '../../src/tui/bashRender.ts';

/** Themes only decorate, so an identity theme keeps assertions about text. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  inverse: (text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const WIDE = 400;

/** Remove result chrome when an assertion is specifically about its content. */
function lines(component: { render(width: number): string[] }, width: number = WIDE): string[] {
  const rendered = component
    .render(width)
    .map((line) => line.trimEnd())
    .map((line) => (line.startsWith(' ') ? line.slice(1) : line));
  if (/^─+$/.test(rendered[0] ?? '')) rendered.shift();
  while (rendered.at(-1) === '') rendered.pop();
  return rendered;
}

describe('abbreviateHome', () => {
  it('replaces every occurrence of the home directory', () => {
    expect(abbreviateHome('/home/me/a and /home/me/b', '/home/me')).toBe('~/a and ~/b');
  });

  it('leaves text alone when the home directory is unknown', () => {
    expect(abbreviateHome('/home/me/a', '')).toBe('/home/me/a');
  });
});

describe('collapseCommand', () => {
  it('keeps a single-line command as-is', () => {
    expect(collapseCommand('ls -la')).toBe('ls -la');
  });

  it('collapses a heredoc to its first line plus a count', () => {
    expect(collapseCommand("python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY")).toBe("python3 - <<'PY' … +3 lines");
  });

  it('ignores blank lines when counting', () => {
    expect(collapseCommand('a\n\n\nb')).toBe('a … +1 lines');
  });

  it('returns an empty string for an empty command', () => {
    expect(collapseCommand('')).toBe('');
  });
});

describe('truncateMiddle', () => {
  it('leaves short text untouched', () => {
    expect(truncateMiddle('abcdef', 10)).toBe('abcdef');
  });

  it('drops the middle and keeps both ends', () => {
    const result = truncateMiddle('abcdefghij', 9);
    expect(result).toBe('abc … hij');
  });

  it('snaps both cuts to a token boundary instead of splitting a word', () => {
    const command = 'rg -l pattern apps/native/package.json || true; find apps -path src/store | head -30';
    const result = truncateMiddle(command, 50);
    expect(result).toBe('rg -l pattern … src/store | head -30');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('still cuts mid-token when one argument would swallow the budget', () => {
    expect(truncateMiddle('a'.repeat(80), 9)).toBe('aaa … aaa');
  });
});

describe('formatBashCommand', () => {
  it('abbreviates home and collapses in one pass', () => {
    const home = process.env.HOME ?? '';
    const command = home.length > 0 ? `tail ${home}/logs/a.log\nsecond line` : 'tail /logs/a.log\nsecond line';
    const result = formatBashCommand(command);
    expect(result).toContain('+1 lines');
    if (home.length > 0) expect(result).not.toContain(home);
  });

  it('preserves a long single-line pipeline in full', () => {
    const command = `git status --short && git add -A && git commit -m "${'detailed message '.repeat(12)}" && git push`;
    expect(formatBashCommand(command)).toBe(command);
  });
});

describe('formatBashFlags', () => {
  it('returns nothing for a plain command', () => {
    expect(formatBashFlags({ command: 'ls' })).toEqual([]);
  });

  it('reports each modifier that is set', () => {
    expect(
      formatBashFlags({ command: 'ls', background: true, interactive: true, timeout: 30, alarm: 15, name: 'api' }),
    ).toEqual(['bg', 'tty', 'alarm 15s', '30s', 'api']);
  });

  it('omits an empty runner name', () => {
    expect(formatBashFlags({ command: 'ls', name: '' })).toEqual([]);
  });
});

describe('renderBashCall', () => {
  /** Stands in for Pi's highlighter, which reads a global theme singleton. */
  const plain = (code: string) => [code];

  it('puts the command on a single line behind the tool label', () => {
    expect(lines(renderBashCall({ command: 'ls -la' }, theme, plain))).toEqual([' BASH  ls -la']);
  });

  it('appends modifiers after the command', () => {
    expect(lines(renderBashCall({ command: 'ls', background: true }, theme, plain))).toEqual([' BASH  ls · bg']);
  });

  it('highlights the command as bash', () => {
    const seen: Array<[string, string | undefined]> = [];
    renderBashCall({ command: 'ls -la' }, theme, (code, lang) => {
      seen.push([code, lang]);
      return [code];
    });
    expect(seen).toEqual([['ls -la', 'bash']]);
  });

  it('highlights the shortened command, never the raw one', () => {
    const seen: string[] = [];
    renderBashCall({ command: 'a\nb\nc' }, theme, (code) => {
      seen.push(code);
      return [code];
    });
    expect(seen).toEqual(['a … +2 lines']);
  });

  it('wraps a long command so its complete tail stays visible', () => {
    const rendered = renderBashCall(
      { command: 'rg -n "a very long pattern" packages/default/doompi-runner/src packages/foundation' },
      theme,
      plain,
    ).render(32);

    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(rendered.join(' ')).toContain('packages/foundation');
    expect(rendered.join('')).not.toContain('…');
  });
});

describe('formatResultSummary', () => {
  it('joins the metadata that used to occupy five lines', () => {
    expect(formatResultSummary({ lines: 1234, fileSize: 13_414, runner: 'msi58ueg' })).toBe(
      '1,234 lines · 13.1 KB · msi58ueg',
    );
  });

  it('skips absent fields', () => {
    expect(formatResultSummary({})).toBe('');
  });
});

describe('renderBashResult', () => {
  const options = { expanded: false, isPartial: false };

  function details(overrides: Partial<BashResultDetails> = {}): BashResultDetails {
    return { exitCode: 0, lines: 3, fileSize: 100, runner: 'api', tail: 'one\ntwo\nthree', tailLines: 3, ...overrides };
  }

  it('shows streaming output under a running marker while partial', () => {
    const result = { content: [{ type: 'text', text: 'building...\n' }] };
    expect(lines(renderBashResult(result, { expanded: false, isPartial: true }, theme))).toEqual([
      'building...',
      '◐ running',
    ]);
  });

  it('separates results without duplicating state icons and leaves trailing space', () => {
    const pending = renderBashResult(
      { content: [{ type: 'text', text: 'building...' }] },
      { expanded: false, isPartial: true },
      theme,
    ).render(20);
    const success = renderBashResult({ details: details() }, options, theme).render(20);
    const error = renderBashResult(
      { content: [{ type: 'text', text: 'failed' }] },
      { ...options, isError: true },
      theme,
    ).render(20);

    expect(pending[0]).toBe(` ${'─'.repeat(18)}`);
    expect(success[0]).toBe(` ${'─'.repeat(18)}`);
    expect(error[0]).toBe(` ${'─'.repeat(18)}`);
    expect(pending.at(-1)).toBe('');
    expect(success.at(-1)).toBe('');
    expect(error.at(-1)).toBe('');
  });

  it('bounds the streamed body so a chatty command cannot overflow the message', () => {
    const streamed = Array.from({ length: 500 }, (_, index) => `step ${index}`).join('\n');
    const rendered = lines(
      renderBashResult({ content: [{ type: 'text', text: streamed }] }, { expanded: false, isPartial: true }, theme),
    );
    expect(rendered).toHaveLength(13);
    expect(rendered[0]).toBe('step 488');
    expect(rendered.at(-1)).toBe('◐ running');
  });

  it('shows the error body when the tool threw and left no details', () => {
    const result = { content: [{ type: 'text', text: 'error: unknown command' }] };
    expect(lines(renderBashResult(result, { ...options, isError: true }, theme))).toEqual([
      'error: unknown command',
      '✗ failed',
    ]);
  });

  it('bounds the error body too', () => {
    const text = Array.from({ length: 90 }, (_, index) => `err ${index}`).join('\n');
    const rendered = lines(
      renderBashResult({ content: [{ type: 'text', text }] }, { ...options, isError: true }, theme),
    );
    expect(rendered).toHaveLength(13);
    expect(rendered.at(-1)).toBe('✗ failed');
  });

  it('reports a promoted runner instead of log output', () => {
    const rendered = lines(renderBashResult({ details: { promoted: true, runner: 'api', id: 'abc' } }, options, theme));
    expect(rendered).toEqual(['● api · abc · background']);
  });

  it('shows the log tail above a one-line summary', () => {
    expect(lines(renderBashResult({ details: details() }, options, theme))).toEqual([
      'one',
      'two',
      'three',
      '✓ 3 lines · 100 B · api',
    ]);
  });

  it('truncates the tail when collapsed and offers the expand hint', () => {
    const tail = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const rendered = lines(renderBashResult({ details: details({ tail, tailLines: 40 }) }, options, theme));
    expect(rendered).toHaveLength(13);
    expect(rendered[0]).toBe('line 28');
    expect(rendered.at(-1)).toContain('ctrl+o');
  });

  it('shows the whole tail when expanded, with no hint', () => {
    const tail = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const rendered = lines(
      renderBashResult({ details: details({ tail, tailLines: 40 }) }, { expanded: true, isPartial: false }, theme),
    );
    expect(rendered).toHaveLength(41);
    expect(rendered[0]).toBe('line 0');
    expect(rendered.at(-1)).not.toContain('ctrl+o');
  });

  it('clips long collapsed log lines instead of wrapping them into extra rows', () => {
    const component = renderBashResult(
      {
        details: details({
          tail: 'packages/default/doompi-runner/tests/a-very-long-file.test.ts:100: result',
          tailLines: 1,
        }),
      },
      options,
      theme,
    );
    const rendered = lines(component, 36);

    expect(rendered).toHaveLength(2);
    expect(visibleWidth(rendered[0] ?? '')).toBe(34);
    expect(rendered[0]).toContain('…');
  });

  it('wraps long log lines when expanded so no content is hidden', () => {
    const output = 'abcdefghijklmnopqrstuvwxyz';
    const component = renderBashResult(
      { details: details({ tail: output, tailLines: 1 }) },
      { expanded: true, isPartial: false },
      theme,
    );
    const rendered = lines(component, 10);

    expect(rendered.slice(0, 4).join('')).toBe(output);
    expect(rendered.length).toBeGreaterThan(3);
  });

  it('marks a non-zero exit as failed', () => {
    const rendered = lines(renderBashResult({ details: details({ exitCode: 1 }) }, options, theme));
    expect(rendered.at(-1)).toBe('✗ exit 1 · 3 lines · 100 B · api');
  });

  it('marks a timeout', () => {
    const rendered = lines(renderBashResult({ details: details({ timedOut: true }) }, options, theme));
    expect(rendered.at(-1)).toContain('timed out');
  });

  it('renders only the summary when there is no output', () => {
    const rendered = lines(renderBashResult({ details: details({ tail: '', tailLines: 0 }) }, options, theme));
    expect(rendered).toEqual(['✓ 3 lines · 100 B · api']);
  });

  it('treats an absent exit code as a named success rather than "exit undefined"', () => {
    expect(lines(renderBashResult({}, options, theme))).toEqual(['✓ done']);
  });

  describe('stdio colour', () => {
    /** Marks every themed span, so an unmarked line proves the theme was not applied. */
    const marking = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;

    it('leaves a line that carries its own colour untouched', () => {
      const coloured = '[32mpassed[39m';
      const rendered = renderBashResult(
        { details: details({ tail: coloured, tailLines: 1 }) },
        options,
        marking,
      ).render(WIDE);
      expect(rendered[1]).toBe(` ${coloured}`);
    });

    it('themes a plain line so uncoloured output still reads as output', () => {
      const rendered = renderBashResult({ details: details({ tail: 'plain', tailLines: 1 }) }, options, marking).render(
        WIDE,
      );
      expect(rendered[1]).toBe(' <toolOutput>plain</toolOutput>');
    });
  });
});
