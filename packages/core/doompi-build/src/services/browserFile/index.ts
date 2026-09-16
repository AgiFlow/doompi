import { CLI_FRONTEND_FIELDS, WEB_FIELDS } from '../../constants/contributions';
import {
  BACKEND_GROUP,
  DEFAULT_ROUTING_ROOT,
  FRONTEND_GROUP,
  FRONTEND_PLATFORMS,
  GATE_SEGMENTS,
  ROUTING_ROOT_ALIAS,
} from '../../constants/layout';
import { parseFilename } from '../filename';
import { classifySegment } from '../segments';

/** The frontend platform that draws in a terminal rather than a browser. */
const TERMINAL_PLATFORM = 'cli';

/**
 * Frontend surfaces the terminal owns outright.
 *
 * Derived from the two frontend tables rather than listed, so a surface the
 * cockpit gains later stops counting as terminal-only the moment `WEB_FIELDS`
 * names it. Today that is `overlay` and `message`.
 */
const TERMINAL_ONLY_SURFACES: readonly string[] = Object.keys(CLI_FRONTEND_FIELDS).filter(
  (surface) => !(surface in WEB_FIELDS),
);

/** The segments below the routing root, or undefined when the path is not routed. */
function routedSegments(relativePath: string): readonly string[] | undefined {
  for (const root of [DEFAULT_ROUTING_ROOT, ROUTING_ROOT_ALIAS]) {
    if (relativePath.startsWith(`${root}/`)) return relativePath.slice(root.length + 1).split('/');
  }
  return undefined;
}

/**
 * Whether a package-relative path holds code the cockpit bundles.
 *
 * Browser-bound is narrower than `(frontend)`. That side carries both
 * presentations, and the terminal's half legitimately imports src/services and
 * pi-tui, so treating the whole side as browser would reject every one of those
 * imports. Two things separate the halves, in this order:
 *
 * - a surface the CLI frontend table names and the web table does not is
 *   terminal-only, whatever the filename says;
 * - on a surface both hosts share, the platform in the filename decides, which
 *   is what tells `tool/x.cli.tsx` from `tool/x.web.tsx`.
 *
 * Everything else under `(frontend)` is browser, including the private folders
 * colocated beside a surface. A private folder sitting directly at the side
 * root names no surface to read, and counts as browser; a terminal helper in
 * that position has to move under the surface it serves.
 *
 * Path in, answer out: nothing here reads the file or the filesystem.
 */
export function isBrowserFile(relativePath: string): boolean {
  const segments = routedSegments(relativePath);
  if (segments === undefined) return false;

  const fileName = segments[segments.length - 1];
  if (fileName === undefined) return false;
  const folders = segments.slice(0, -1);
  let index = 0;

  // The first side group decides the side, the way the scan reads it.
  let side: string | undefined;
  while (index < folders.length && side === undefined) {
    const segment = classifySegment(folders[index]);
    index += 1;
    if (segment.kind !== 'group') continue;
    if (segment.name === BACKEND_GROUP || segment.name === FRONTEND_GROUP) side = segment.name;
  }
  if (side !== FRONTEND_GROUP) return false;

  // The surface is the first named segment below the side. Groups and private
  // folders are transparent, and a gate folder takes its id segment with it.
  let surface: string | undefined;
  while (index < folders.length && surface === undefined) {
    const segment = classifySegment(folders[index]);
    index += 1;
    if (segment.kind !== 'plain') continue;
    if (GATE_SEGMENTS.includes(segment.name)) index += 1;
    else surface = segment.name;
  }
  if (surface !== undefined && TERMINAL_ONLY_SURFACES.includes(surface)) return false;

  return parseFilename(fileName, FRONTEND_PLATFORMS)?.platform !== TERMINAL_PLATFORM;
}
