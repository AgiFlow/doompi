import { describe, expect, it } from 'vitest';
import { formatProgressLine, SyncProgress } from '../../src/commands/syncPresenter.ts';

const CLEAR_LINE = `${String.fromCharCode(0x1b)}[2K\r`;

function capture(isTTY?: boolean): { chunks: string[]; output: { write(chunk: string): boolean; isTTY?: boolean } } {
  const chunks: string[] = [];
  return {
    chunks,
    output: {
      isTTY,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

describe('SyncProgress', () => {
  it('aligns a step label with the sync summary block', () => {
    expect(formatProgressLine('packages', 'already up to date')).toBe('packages: already up to date');
    expect(formatProgressLine('build', 'compiled')).toBe('build:    compiled');
  });

  it('writes only completed steps, with their duration, outside a terminal', () => {
    const { chunks, output } = capture();
    let clock = 1_000;
    const progress = new SyncProgress(output, () => clock);

    const done = progress.start('packages', 'checking configured packages for updates');
    clock = 3_500;
    done('updated 2 packages');

    expect(chunks).toEqual(['packages: updated 2 packages (2.5s)\n']);
  });

  it('overwrites the live step once it completes on a terminal', () => {
    const { chunks, output } = capture(true);
    const progress = new SyncProgress(output, () => 0);

    const done = progress.start('build', 'compiling the mode extension');
    done('mode extension compiled');

    expect(chunks).toEqual([
      `${CLEAR_LINE}build:    compiling the mode extension...`,
      CLEAR_LINE,
      'build:    mode extension compiled (0.0s)\n',
    ]);
  });

  it('clears the live step before a standalone line so both stay readable', () => {
    const { chunks, output } = capture(true);
    const progress = new SyncProgress(output, () => 0);

    const done = progress.start('packages', 'checking configured packages for updates');
    progress.line('packages', '@scope/team 1.0.0 -> 1.1.0');
    done('updated 1 package');

    expect(chunks).toEqual([
      `${CLEAR_LINE}packages: checking configured packages for updates...`,
      CLEAR_LINE,
      'packages: @scope/team 1.0.0 -> 1.1.0\n',
      'packages: updated 1 package (0.0s)\n',
    ]);
  });
});
