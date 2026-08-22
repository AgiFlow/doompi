import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, FileEditState } from '../../types/domain';
import type { IGitDiffService } from '../../types/gitDiffService';

export const MAX_DIFF_LINES = 200;
export const MAX_DIFF_BYTES = 256 * 1024;
const BINARY_SAMPLE_BYTES = 8192;

function capLines(lines: string[], byteTruncated: boolean): { lines: string[]; truncated: boolean } {
  const truncated = byteTruncated || lines.length > MAX_DIFF_LINES;
  const visible = lines.slice(0, MAX_DIFF_LINES);
  if (truncated) visible.push(`... diff truncated at ${MAX_DIFF_LINES} lines / ${MAX_DIFF_BYTES} bytes ...`);
  return { lines: visible, truncated };
}

function summarize(pathValue: string, state: FileEditState, tracked: boolean, raw: Buffer): FileDiff {
  const byteTruncated = raw.byteLength >= MAX_DIFF_BYTES;
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    return {
      path: pathValue,
      state: 'binary',
      lines: [`Binary file changed (${raw.byteLength} bytes shown by git)`],
      additions: 0,
      removals: 0,
      tracked,
      truncated: byteTruncated,
      suggestedLine: 1,
    };
  }
  const capped = capLines(raw.subarray(0, MAX_DIFF_BYTES).toString('utf8').split('\n'), byteTruncated);
  const additions = capped.lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removals = capped.lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const hunk = capped.lines.find((line) => line.startsWith('@@'))?.match(/\+(\d+)/u);
  return {
    path: pathValue,
    state,
    lines: capped.lines,
    additions,
    removals,
    tracked,
    truncated: capped.truncated,
    suggestedLine: Number(hunk?.[1] ?? 1),
  };
}

export class GitDiffService implements IGitDiffService {
  async diff(cwd: string, filePath: string): Promise<FileDiff> {
    const absolute = path.resolve(cwd, filePath);
    const relative = path.relative(cwd, absolute);
    const tracked = this.isTracked(cwd, relative);
    let exists = true;
    try {
      await fs.access(absolute);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
      else throw error;
    }
    if (!tracked && !exists) return summarize(absolute, 'deleted', false, Buffer.from('File no longer exists'));
    if (!tracked) return this.fullAdd(absolute);
    const result = spawnSync('git', ['diff', '--no-ext-diff', '--no-color', '--unified=3', 'HEAD', '--', relative], {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_DIFF_BYTES,
    });
    const output = result.stdout ?? Buffer.alloc(0);
    if (exists && /^(Binary files .* differ|GIT binary patch)$/mu.test(output.toString('utf8'))) {
      return {
        path: absolute,
        state: 'binary',
        lines: ['Binary tracked file changed'],
        additions: 0,
        removals: 0,
        tracked: true,
        truncated: false,
        suggestedLine: 1,
      };
    }
    const state: FileEditState = exists ? (output.length > 0 ? 'modified' : 'unchanged') : 'deleted';
    return summarize(absolute, state, true, output);
  }

  private isTracked(cwd: string, relative: string): boolean {
    return spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd, stdio: 'ignore' }).status === 0;
  }

  private async fullAdd(filePath: string): Promise<FileDiff> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_DIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const sample = buffer.subarray(0, bytesRead);
      if (sample.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
        return summarize(filePath, 'binary', false, Buffer.from(`Binary untracked file (${bytesRead}+ bytes)`));
      }
      const body = sample
        .toString('utf8')
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n');
      const header = `--- /dev/null\n+++ b/${path.basename(filePath)}\n@@ -0,0 +1 @@\n`;
      return summarize(filePath, 'added', false, Buffer.from(header + body));
    } finally {
      await handle.close();
    }
  }
}
