import { EXCLUDED_INFIXES, SOURCE_EXTENSIONS } from '../../constants/layout';

/** One filename split into the four things the grammar encodes. */
export interface ParsedFilename {
  /** The contribution's identity. */
  readonly name: string;
  /** The relationship target, such as the slot a fill names. */
  readonly target: string | undefined;
  /** The platform this file serves, or undefined for the side's neutral file. */
  readonly platform: string | undefined;
  readonly extension: string;
}

/**
 * Parses `{name}[.{target}][.{platform}].{ext}`.
 *
 * Right to left, because the platform set is closed and the target is not: a
 * dotted slot name such as `task.detail` would otherwise be ambiguous. A file
 * whose extension is not a source extension, or that carries an excluded
 * infix, returns undefined rather than an entry the caller has to filter.
 *
 * The one word a target may not be is a platform name for its own side, since
 * the last segment is read as a platform whenever it matches.
 */
export function parseFilename(fileName: string, platforms: readonly string[]): ParsedFilename | undefined {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) return undefined;

  const extension = fileName.slice(lastDot + 1);
  if (!SOURCE_EXTENSIONS.includes(extension)) return undefined;

  const parts = fileName.slice(0, lastDot).split('.');
  const [name, ...rest] = parts;
  if (name === undefined || name === '') return undefined;
  if (parts.some((part) => EXCLUDED_INFIXES.includes(part))) return undefined;

  const last = rest[rest.length - 1];
  const platform = last !== undefined && platforms.includes(last) ? rest.pop() : undefined;

  return { name, target: rest.length > 0 ? rest.join('.') : undefined, platform, extension };
}
