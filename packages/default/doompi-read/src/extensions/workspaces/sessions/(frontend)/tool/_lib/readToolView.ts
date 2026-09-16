import { compactDetails } from '@agimon-ai/doompi-web-components';

export interface ReadCallView {
  readonly path: string;
  /** `from N` and `N lines`, as the TUI's call heading lists them. */
  readonly details: readonly string[];
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** What the read call heading shows: the path, then the offset and limit when given. */
export function readCallView(args: Readonly<Record<string, unknown>>): ReadCallView {
  const offset = optionalNumber(args.offset);
  const limit = optionalNumber(args.limit);
  return {
    path: typeof args.path === 'string' ? args.path : '',
    details: compactDetails([
      offset === undefined ? undefined : `from ${offset}`,
      limit === undefined ? undefined : `${limit} lines`,
    ]),
  };
}
