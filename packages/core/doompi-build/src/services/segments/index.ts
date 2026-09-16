import {
  CATCH_ALL_MARKER,
  DYNAMIC_PREFIX,
  DYNAMIC_SUFFIX,
  GROUP_PREFIX,
  GROUP_SUFFIX,
  PRIVATE_PREFIX,
} from '../../constants/layout';
import type { RouteParam } from '../../types/extensionGraph';

/**
 * What one folder name means, using Next.js spelling throughout.
 *
 * A group is organisational and invisible to the path. A private folder is
 * colocation and is never scanned. A dynamic segment is a route parameter.
 * Everything else is a plain segment whose meaning depends on where it sits.
 */
export type Segment =
  | { readonly kind: 'group'; readonly name: string }
  | { readonly kind: 'private'; readonly name: string }
  | { readonly kind: 'dynamic'; readonly param: RouteParam }
  | { readonly kind: 'plain'; readonly name: string };

function wrapped(segment: string, open: string, close: string): string | undefined {
  if (segment.length <= open.length + close.length) return undefined;
  if (!segment.startsWith(open) || !segment.endsWith(close)) return undefined;
  return segment.slice(open.length, segment.length - close.length);
}

/** Classifies one folder name. Never throws: an unusable name is simply plain. */
export function classifySegment(segment: string): Segment {
  if (segment.startsWith(PRIVATE_PREFIX)) return { kind: 'private', name: segment.slice(PRIVATE_PREFIX.length) };

  const group = wrapped(segment, GROUP_PREFIX, GROUP_SUFFIX);
  if (group !== undefined) return { kind: 'group', name: group };

  const dynamic = wrapped(segment, DYNAMIC_PREFIX, DYNAMIC_SUFFIX);
  if (dynamic !== undefined) {
    const catchAll = dynamic.startsWith(CATCH_ALL_MARKER);
    return {
      kind: 'dynamic',
      param: { name: catchAll ? dynamic.slice(CATCH_ALL_MARKER.length) : dynamic, catchAll },
    };
  }

  return { kind: 'plain', name: segment };
}
