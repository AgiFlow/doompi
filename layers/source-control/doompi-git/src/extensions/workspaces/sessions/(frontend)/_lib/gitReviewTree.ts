/**
 * The review browser's folder tree: changed files nested by directory, with
 * single-child folder chains compacted into one row like VS Code's explorer.
 */
import type { GitReviewFileEntry } from '../../../../../types/gitReview';

interface TreeDir {
  path: string;
  dirs: Map<string, TreeDir>;
  files: GitReviewFileEntry[];
}

export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; file: GitReviewFileEntry; depth: number };

function buildTree(files: readonly GitReviewFileEntry[]): TreeDir {
  const root: TreeDir = { path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { path: dir.path === '' ? part : `${dir.path}/${part}`, dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  return root;
}

/** Folders first, then files, each alphabetical; single-child folder chains render as one row. */
export function flattenTree(files: readonly GitReviewFileEntry[], isOpen: (dirPath: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: TreeDir, depth: number): void => {
    for (const [segment, child] of [...dir.dirs].sort(([left], [right]) => left.localeCompare(right))) {
      let name = segment;
      let node = child;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[nextName, next]] = [...node.dirs] as [[string, TreeDir]];
        name = `${name}/${nextName}`;
        node = next;
      }
      const open = isOpen(node.path);
      rows.push({ kind: 'dir', path: node.path, name, depth, open });
      if (open) walk(node, depth + 1);
    }
    for (const file of [...dir.files].sort((left, right) => left.path.localeCompare(right.path))) {
      rows.push({ kind: 'file', file, depth });
    }
  };
  walk(buildTree(files), 0);
  return rows;
}
