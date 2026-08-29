import ignore from 'ignore';
import type { FilesItemView } from '../types/webFiles.ts';

function matchablePath(relPath: string): string | undefined {
  const normalized = relPath.replace(/\\/gu, '/');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/** Applies project-local gitignore rules while keeping unsafe candidates visible. */
export function filterDoomIgnoredFiles(items: FilesItemView[], content: string): FilesItemView[] {
  try {
    if (content.trim().length === 0) return items;
    const matcher = ignore().add(content);
    return items.filter((item) => {
      const candidate = matchablePath(item.relPath);
      return candidate === undefined || !matcher.ignores(candidate);
    });
  } catch {
    return items;
  }
}
