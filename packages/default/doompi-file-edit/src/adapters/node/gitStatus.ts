import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitStatusPort } from '../../types/gitStatus.ts';

/**
 * Answers the unchanged question with git, in two batched calls per chunk.
 *
 * One technology per adapter. This is where git enters the scan path; the
 * tracker that depends on the capability keeps importing the port.
 *
 * `ls-files` names which of the given paths git tracks at all, and `status`
 * names which of those moved. Everything else, an ignored build artefact, a
 * temporary file, a tree with no repository, falls out of both answers and is
 * therefore never reported as unchanged: the caller must keep recording it,
 * because git has nothing to say about a file it never saw.
 */

/** Paths per git invocation, so a large scan cannot overflow the argument list. */
const CHUNK = 200;
const MAX_BUFFER = 4 * 1024 * 1024;

const run = promisify(execFile);

function chunked<T>(values: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

function splitRecords(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/**
 * The paths named by `status --porcelain -z`, whose records carry a two-letter
 * code and a space. A rename adds a bare second record; keeping it is harmless,
 * because every path in this set is one the caller records anyway.
 */
function statusPaths(output: string): string[] {
  return splitRecords(output).map((record) => (record.length > 3 && record[2] === ' ' ? record.slice(3) : record));
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class NodeGitStatusAdapter implements GitStatusPort {
  async unchanged(cwd: string, filePaths: readonly string[]): Promise<ReadonlySet<string>> {
    const clean = new Set<string>();
    if (filePaths.length === 0) return clean;
    const root = await this.topLevel(cwd);
    if (root === undefined) return clean;

    for (const group of chunked(
      filePaths.filter((filePath) => isInside(root, filePath)),
      CHUNK,
    )) {
      const relative = group.map((filePath) => path.relative(root, filePath));
      const tracked = await this.git(root, ['ls-files', '-z', '--', ...relative]);
      if (tracked === undefined) continue;
      const dirty = await this.git(root, ['status', '--porcelain', '-z', '--untracked-files=no', '--', ...relative]);
      if (dirty === undefined) continue;
      const moved = new Set(statusPaths(dirty));
      for (const entry of splitRecords(tracked)) {
        if (!moved.has(entry)) clean.add(path.resolve(root, entry));
      }
    }
    return clean;
  }

  /** The repository root, or undefined when this tree is not one. */
  private async topLevel(cwd: string): Promise<string | undefined> {
    const output = await this.git(cwd, ['rev-parse', '--show-toplevel']);
    const root = output?.trim();
    return root === undefined || root === '' ? undefined : path.resolve(root);
  }

  /** Git's stdout, or undefined when the call failed for any reason at all. */
  private async git(cwd: string, args: readonly string[]): Promise<string | undefined> {
    try {
      const { stdout } = await run('git', [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
      return stdout;
    } catch {
      return undefined;
    }
  }
}
