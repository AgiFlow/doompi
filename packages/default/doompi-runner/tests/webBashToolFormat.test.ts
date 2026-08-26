import { describe, expect, it } from 'vitest';
import {
  abbreviateHome,
  bashResultDetails,
  bashResultView,
  collapseCommand,
  formatBashCommand,
  formatBashFlags,
  formatResultSummary,
  formatSize,
  truncateMiddle,
} from '../web/bashToolFormat.ts';

describe('the bash web call summary', () => {
  it('collapses scripts, abbreviates home paths, and keeps both ends of a long pipeline', () => {
    expect(collapseCommand('  ls\n\n  cat a\n')).toBe('ls … +1 lines');
    expect(abbreviateHome('cat /Users/me/notes.txt /home/ci/x')).toBe('cat ~/notes.txt ~/x');
    expect(abbreviateHome('/Users/me')).toBe('~');
    const long = `echo ${'a'.repeat(100)} | ${'b'.repeat(100)} > out`;
    const cut = truncateMiddle(long, 60);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.startsWith('echo')).toBe(true);
    expect(cut.endsWith('> out')).toBe(true);
    expect(truncateMiddle('short')).toBe('short');
    expect(formatBashCommand('pnpm test\n')).toBe('pnpm test');
  });

  it('lists the modifiers in the widget idiom', () => {
    expect(formatBashFlags({})).toEqual([]);
    expect(formatBashFlags({ background: true, interactive: true, alarm: 30, timeout: 5, name: 'dev' })).toEqual([
      'bg',
      'tty',
      'alarm 30s',
      '5s',
      'dev',
    ]);
    expect(formatBashFlags({ name: '', timeout: '5' })).toEqual([]);
  });
});

describe('the bash web result view', () => {
  it('narrows the wire details and formats the footer summary', () => {
    expect(bashResultDetails('junk')).toEqual({});
    expect(
      bashResultDetails({ id: 'r1', runner: 'dev', exitCode: null, fileSize: 2048, lines: 1200, tail: 'x', extra: 1 }),
    ).toEqual({ id: 'r1', runner: 'dev', exitCode: null, fileSize: 2048, lines: 1200, tail: 'x' });
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatResultSummary({ lines: 1200, fileSize: 2048, runner: 'dev' })).toBe('1,200 lines · 2.0 KB · dev');
    expect(formatResultSummary({})).toBe('');
  });

  it('shows a bounded stream while running', () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const view = bashResultView({ details: undefined, output, expanded: false, isPartial: true, isError: false });
    expect(view.lines).toHaveLength(12);
    expect(view.lines[0]).toBe('line 8');
    expect(view.status).toEqual({ glyph: '◐', tone: 'running', text: 'running' });
  });

  it('shows the error text with a failed footer when the tool threw', () => {
    const view = bashResultView({
      details: {},
      output: 'boom\nexit 1\n',
      expanded: false,
      isPartial: false,
      isError: true,
    });
    expect(view.lines).toEqual(['boom', 'exit 1']);
    expect(view.status).toEqual({ glyph: '✗', tone: 'error', text: 'failed' });
    const many = Array.from({ length: 15 }, (_, index) => `e${index}`).join('\n');
    const clipped = bashResultView({ details: {}, output: many, expanded: false, isPartial: false, isError: true });
    expect(clipped.lines).toHaveLength(12);
    expect(clipped.hidden).toBe(3);
    expect(bashResultView({ details: {}, output: many, expanded: true, isPartial: false, isError: true }).hidden).toBe(
      0,
    );
  });

  it('reports a promoted runner as background work', () => {
    const view = bashResultView({
      details: { promoted: true, runner: 'dev', id: 'r1' },
      output: '',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(view.lines).toEqual([]);
    expect(view.status).toEqual({ glyph: '●', tone: 'background', text: 'dev · r1 · background' });
    expect(
      bashResultView({ details: { promoted: true }, output: '', expanded: false, isPartial: false, isError: false })
        .status?.text,
    ).toBe('runner · background');
  });

  it('shows the tail with the summary footer, and marks exits and timeouts', () => {
    const ok = bashResultView({
      details: { tail: 'a\nb\n', tailLines: 2, lines: 2, fileSize: 4, runner: 'dev', exitCode: 0 },
      output: 'a\nb',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(ok.lines).toEqual(['a', 'b']);
    expect(ok.status).toEqual({ glyph: '✓', tone: 'ok', text: '2 lines · 4 B · dev' });

    const empty = bashResultView({
      details: { exitCode: 0 },
      output: '',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(empty.status).toEqual({ glyph: '✓', tone: 'ok', text: 'done' });

    const exit = bashResultView({
      details: { exitCode: 2, tail: 'x' },
      output: 'x',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(exit.status).toEqual({ glyph: '✗', tone: 'error', text: 'exit 2' });

    const timedOut = bashResultView({
      details: { timedOut: true, exitCode: null },
      output: '',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(timedOut.status).toEqual({ glyph: '✗', tone: 'error', text: 'timed out' });

    const unreported = bashResultView({
      details: { exitCode: null, tail: 'y' },
      output: 'y',
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(unreported.status).toBeNull();

    const tail = Array.from({ length: 30 }, (_, index) => `t${index}`).join('\n');
    const clipped = bashResultView({
      details: { tail, tailLines: 30, exitCode: 0 },
      output: tail,
      expanded: false,
      isPartial: false,
      isError: false,
    });
    expect(clipped.lines).toHaveLength(12);
    expect(clipped.lines[0]).toBe('t18');
    expect(clipped.hidden).toBe(18);
    const whole = bashResultView({
      details: { tail, tailLines: 30, exitCode: 0 },
      output: tail,
      expanded: true,
      isPartial: false,
      isError: false,
    });
    expect(whole.lines).toHaveLength(30);
    expect(whole.hidden).toBe(0);
  });
});
