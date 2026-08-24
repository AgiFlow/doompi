import { compactDetails } from './hashlineView.ts';

export interface GrepCallView {
  readonly pattern: string;
  /** Search path, glob, case flag, and limit, as the TUI's call heading lists them. */
  readonly details: readonly string[];
}

/** What the grep call heading shows: the pattern, then where and how it searched. */
export function grepCallView(args: Readonly<Record<string, unknown>>): GrepCallView {
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : undefined;
  return {
    pattern: typeof args.pattern === 'string' ? args.pattern : '',
    details: compactDetails([
      typeof args.path === 'string' && args.path.length > 0 ? args.path : '.',
      typeof args.glob === 'string' ? args.glob : undefined,
      args.ignoreCase === true ? 'ignore case' : undefined,
      limit === undefined ? undefined : `${limit} matches`,
    ]),
  };
}
