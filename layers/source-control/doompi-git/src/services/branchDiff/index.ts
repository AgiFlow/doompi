import fs from 'node:fs';
import path from 'node:path';

import type {
  GitChangesView,
  GitDiffHunk,
  GitDiffRow,
  GitReviewFileDiff,
  GitReviewFileEntry,
  GitReviewFileStatus,
} from '../../types/gitReview';
import { READ_TIMEOUT_MS, runGit } from '../gitCli';
import type { BranchDiff, BranchDiffOptions, BranchReview, ReviewBase } from './type';

/**
 * What a session's checkout changed against its base, the way a pull request
 * shows it: every commit since the branch left its base, plus staged, unstaged
 * and untracked work.
 *
 * DESIGN PATTERNS:
 * - git computes every diff. The counts come from `--numstat` and the hunks
 *   from the same unified diff, so the two always agree.
 * - The base is the worktree's own recorded base when there is one, then the
 *   remote's default branch, then the branch's upstream, and with none of those
 *   only uncommitted work counts. It is always named in the UI.
 * - Untracked files are read only when they are small regular files; a symlink
 *   shows its link text and is never followed.
 *
 * AVOID:
 * - Passing a browser path to git without checking it against the change set.
 */

/** git's well-known empty tree, the base of a repository with no commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_LISTED_FILES = 500;
const MAX_UNTRACKED_COUNTED = 200;
const MAX_FILE_BYTES = 1_048_576;
const MAX_ROWS = 5_000;
const BINARY_PROBE_BYTES = 8_192;
const SHORT_SHA = 7;
const DEFAULT_BRANCHES = ['main', 'master'];

async function read(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runGit(cwd, args, { timeout: READ_TIMEOUT_MS });
  return result.code === 0 ? result.stdout : undefined;
}

async function readLine(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const out = (await read(cwd, args))?.trim();
  return out === undefined || out === '' ? undefined : out;
}

async function commitExists(cwd: string, ref: string): Promise<boolean> {
  return (await readLine(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== undefined;
}

/** A local branch's upstream, so the review measures against what fetch keeps current. */
async function upstreamOf(cwd: string, ref: string): Promise<string | undefined> {
  return readLine(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ref}@{upstream}`]);
}

/** The ref the review is measured against. Exported for sync, whose rebase uses the same base. */
export async function resolveBaseRef(
  cwd: string,
  branch: string | undefined,
  recordedBaseRef?: string,
): Promise<string | undefined> {
  // An existing-branch worktree records the branch itself as its base, which
  // would make every review empty.
  const recordedIsSelf =
    recordedBaseRef === undefined ||
    (branch !== undefined && (recordedBaseRef === branch || recordedBaseRef.endsWith(`/${branch}`)));
  if (!recordedIsSelf && recordedBaseRef !== undefined && (await commitExists(cwd, recordedBaseRef))) {
    const isLocal =
      (await readLine(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${recordedBaseRef}`])) !== undefined;
    return (isLocal ? await upstreamOf(cwd, recordedBaseRef) : undefined) ?? recordedBaseRef;
  }
  const originHead = await readLine(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead !== undefined) return originHead;
  for (const name of DEFAULT_BRANCHES) {
    if (await commitExists(cwd, `origin/${name}`)) return `origin/${name}`;
  }
  return branch === undefined ? undefined : upstreamOf(cwd, branch);
}

async function resolveBase(cwd: string, branch: string | undefined, recordedBaseRef?: string): Promise<ReviewBase> {
  const ref = await resolveBaseRef(cwd, branch, recordedBaseRef);
  const head = await commitExists(cwd, 'HEAD');
  if (ref !== undefined && head) {
    const mergeBase = await readLine(cwd, ['merge-base', ref, 'HEAD']);
    if (mergeBase !== undefined) return { ref, from: mergeBase, mergeBase: mergeBase.slice(0, SHORT_SHA) };
  }
  return { from: head ? 'HEAD' : EMPTY_TREE };
}

/** NUL-separated fields from a `-z` listing, without the trailing empty one. */
function zFields(out: string | undefined): string[] {
  if (out === undefined || out === '') return [];
  const fields = out.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

const NAME_STATUS: Readonly<Record<string, GitReviewFileStatus>> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
};

/** Line count of a small regular file, or undefined when it is binary, large, or not a regular file. */
function untrackedLines(root: string, relPath: string): { lines: number; binary: boolean } | undefined {
  const absolute = path.join(root, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return { lines: 1, binary: false };
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  const content = fs.readFileSync(absolute);
  if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { lines: 0, binary: true };
  if (content.length === 0) return { lines: 0, binary: false };
  const text = content.toString('utf8');
  const newlines = text.split('\n').length - 1;
  return { lines: text.endsWith('\n') ? newlines : newlines + 1, binary: false };
}

/** The hunks of a unified diff, numbering each row by the file it lives in. */
export function parseUnifiedDiff(diff: string): { hunks: GitDiffHunk[]; binary: boolean; rows: number } {
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let rows = 0;
  let binary = false;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { start: newLine, rows: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      continue;
    }
    const marker = line[0];
    let row: GitDiffRow | undefined;
    if (marker === ' ') row = { marker: ' ', line: newLine, content: line.slice(1) };
    else if (marker === '-') row = { marker: '-', line: oldLine, content: line.slice(1) };
    else if (marker === '+') row = { marker: '+', line: newLine, content: line.slice(1) };
    // `\ No newline at end of file` and the trailing empty split are not rows.
    if (row === undefined) continue;
    if (marker !== '+') oldLine += 1;
    if (marker !== '-') newLine += 1;
    current.rows.push(row);
    rows += 1;
  }
  return { hunks, binary, rows };
}

export function createBranchDiff(): BranchDiff {
  return {
    async review(cwd: string, options: BranchDiffOptions = {}): Promise<BranchReview | undefined> {
      const root = await readLine(cwd, ['rev-parse', '--show-toplevel']);
      if (root === undefined) return undefined;
      const branch = await readLine(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const base = await resolveBase(root, branch, options.recordedBaseRef);

      const numstat = zFields(await read(root, ['diff', '--numstat', '-z', '--no-renames', base.from]));
      const nameStatus = zFields(await read(root, ['diff', '--name-status', '-z', '--no-renames', base.from]));
      const unmerged = new Set(zFields(await read(root, ['diff', '--name-only', '--diff-filter=U', '-z'])));
      const statusOf = new Map<string, GitReviewFileStatus>();
      for (let index = 0; index + 1 < nameStatus.length; index += 2) {
        statusOf.set(nameStatus[index + 1] ?? '', NAME_STATUS[(nameStatus[index] ?? '').charAt(0)] ?? 'modified');
      }

      const entries: GitReviewFileEntry[] = [];
      for (const field of numstat) {
        const [added = '', removed = '', ...rest] = field.split('\t');
        const filePath = rest.join('\t');
        if (filePath === '') continue;
        const binary = added === '-' && removed === '-';
        entries.push({
          path: filePath,
          status: unmerged.has(filePath) ? 'conflicted' : (statusOf.get(filePath) ?? 'modified'),
          added: binary ? 0 : Number(added),
          removed: binary ? 0 : Number(removed),
          ...(binary ? { binary: true } : {}),
        });
      }

      const untracked = zFields(await read(root, ['ls-files', '--others', '--exclude-standard', '-z']));
      untracked.forEach((relPath, index) => {
        const counted = index < MAX_UNTRACKED_COUNTED ? untrackedLines(root, relPath) : undefined;
        entries.push({
          path: relPath,
          status: 'untracked',
          added: counted?.lines ?? 0,
          removed: 0,
          ...(counted?.binary ? { binary: true } : {}),
        });
      });
      entries.sort((left, right) => left.path.localeCompare(right.path));

      const conflicts = [...unmerged];
      const rebaseMerge = await readLine(root, ['rev-parse', '--git-path', 'rebase-merge']);
      const rebaseApply = await readLine(root, ['rev-parse', '--git-path', 'rebase-apply']);
      const rebasing = [rebaseMerge, rebaseApply].some(
        (gitPath) => gitPath !== undefined && fs.existsSync(path.resolve(root, gitPath)),
      );

      const upstreamRef = branch === undefined ? undefined : await upstreamOf(root, branch);
      let upstream: GitChangesView['upstream'];
      if (upstreamRef !== undefined) {
        const counts = await readLine(root, ['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`]);
        const [behind, ahead] = (counts ?? '').split(/\s+/u).map(Number);
        if (Number.isInteger(ahead) && Number.isInteger(behind))
          upstream = { ref: upstreamRef, ahead: ahead!, behind: behind! };
      }

      const truncated = entries.length > MAX_LISTED_FILES || untracked.length > MAX_UNTRACKED_COUNTED;
      const added = entries.reduce((sum, entry) => sum + entry.added, 0);
      const removed = entries.reduce((sum, entry) => sum + entry.removed, 0);
      const changes: GitChangesView = {
        added,
        removed,
        files: entries.length,
        ...(branch === undefined ? {} : { branch }),
        ...(base.ref === undefined ? {} : { base: base.ref }),
        ...(truncated ? { truncated: true } : {}),
        ...(upstream === undefined ? {} : { upstream }),
        ...(rebasing ? { rebase: { conflicts } } : {}),
      };
      return {
        root,
        base,
        changes,
        summary: {
          repository: true,
          files: entries.slice(0, MAX_LISTED_FILES),
          ...(branch === undefined ? {} : { branch }),
          ...(base.ref === undefined ? {} : { base: base.ref }),
          ...(base.mergeBase === undefined ? {} : { mergeBase: base.mergeBase }),
          ...(truncated ? { truncated: true } : {}),
        },
      };
    },

    async fileDiff(review: BranchReview, filePath: string): Promise<GitReviewFileDiff> {
      const entry = review.summary.files.find((file) => file.path === filePath);
      if (entry === undefined) throw new Error('That path is not in this review.');
      if (entry.status === 'untracked') {
        const absolute = path.join(review.root, entry.path);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          return {
            path: entry.path,
            hunks: [{ start: 1, rows: [{ marker: '+', line: 1, content: fs.readlinkSync(absolute) }] }],
          };
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { path: entry.path, hunks: [], tooLarge: true };
        const content = fs.readFileSync(absolute);
        if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { path: entry.path, hunks: [], binary: true };
        const lines = content.toString('utf8').split('\n');
        if (lines.at(-1) === '') lines.pop();
        if (lines.length > MAX_ROWS) return { path: entry.path, hunks: [], tooLarge: true };
        return {
          path: entry.path,
          hunks:
            lines.length === 0
              ? []
              : [{ start: 1, rows: lines.map((content, index) => ({ marker: '+', line: index + 1, content })) }],
        };
      }
      const result = await runGit(
        review.root,
        [
          'diff',
          '-U3',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          review.base.from,
          '--',
          `:(top,literal)${entry.path}`,
        ],
        { timeout: READ_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES },
      );
      if (result.overflow) return { path: entry.path, hunks: [], tooLarge: true };
      if (result.code !== 0) throw new Error(`git diff failed (exit ${String(result.code)}).`);
      const parsed = parseUnifiedDiff(result.stdout);
      if (parsed.binary || entry.binary === true) return { path: entry.path, hunks: [], binary: true };
      if (parsed.rows > MAX_ROWS) return { path: entry.path, hunks: [], tooLarge: true };
      return { path: entry.path, hunks: parsed.hunks };
    },
  };
}
