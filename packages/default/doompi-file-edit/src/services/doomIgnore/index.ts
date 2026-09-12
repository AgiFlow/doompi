import ignore from 'ignore';
import type { FilesItemView } from '../../types/webFiles';

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

/**
 * Builds the project's ignore test, or nothing when there are no rules.
 *
 * Shared because the same rules are needed twice: once when deciding what to
 * record, and once when deciding what to list. A caller that built its own
 * matcher would let the two drift apart.
 *
 * The test answers false for anything it cannot safely match, so a path that
 * escapes the project stays visible rather than being hidden by accident.
 */
export function createDoomIgnoreMatcher(content: string): ((relPath: string) => boolean) | undefined {
  try {
    if (content.trim().length === 0) return undefined;
    const matcher = ignore().add(content);
    return (relPath: string): boolean => {
      const candidate = matchablePath(relPath);
      return candidate !== undefined && matcher.ignores(candidate);
    };
  } catch {
    return undefined;
  }
}

/** Applies project-local gitignore rules while keeping unsafe candidates visible. */
export function filterDoomIgnoredFiles(items: FilesItemView[], content: string): FilesItemView[] {
  const ignored = createDoomIgnoreMatcher(content);
  if (ignored === undefined) return items;
  return items.filter((item) => !ignored(item.relPath));
}
