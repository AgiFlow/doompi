/**
 * The folder-convention vocabulary, in one place.
 *
 * Every name here is part of the authoring contract in
 * docs/extension-layout.md. Adding a surface means adding it to both.
 */

/** Where the scan starts, package-relative. */
export const DEFAULT_ROUTING_ROOT = 'src/extensions';
/** Accepted spelling of the same root, for packages that prefer the singular. */
export const ROUTING_ROOT_ALIAS = 'src/extension';

/** Group folders that also select a build side. */
export const BACKEND_GROUP = 'backend';
export const FRONTEND_GROUP = 'frontend';

/** Scope segments, in nesting order below the routing root. */
export const WORKSPACE_SEGMENT = 'workspaces';
export const SESSION_SEGMENT = 'sessions';

/** Gate folders. Each is followed by exactly one id segment. */
export const GATE_SEGMENTS: readonly string[] = ['mode', 'domain'];

/** The reserved filename carrying contributions no surface folder covers. */
export const ESCAPE_HATCH_NAME = 'extra';

/** The leaf filename of an HTTP route, as Next.js spells it. */
export const ROUTE_FILE_NAME = 'route';

/**
 * Where generated entries are written, package-relative.
 *
 * Not `src`. That directory is authored code, and a build that writes into it
 * makes every package carry output its author did not write and must not edit.
 * This one is gitignored per package, and the repository's formatter already
 * skips a directory by this name.
 */
export const GENERATED_DIR = 'generated';

/** Generated entry basenames. Never scanned, never hand-edited. */
export const GENERATED_ENTRY_NAMES: readonly string[] = ['pi', 'server', 'web'];

/** Platform suffixes, scoped to their side. A target may not reuse one of these words. */
export const BACKEND_PLATFORMS: readonly string[] = ['cli', 'server'];
export const FRONTEND_PLATFORMS: readonly string[] = ['web', 'ios', 'android', 'desktop'];

/**
 * Surfaces that produce contributions on the backend side.
 *
 * `mode` is absent on purpose: it is a gate folder, so it is consumed before
 * the surface check and its declaration file synthesises the surface instead.
 */
export const BACKEND_SURFACES: readonly string[] = [
  'tool',
  'command',
  'hook',
  'service',
  'api',
  'channel',
  'method',
  'activity',
];

/** Surfaces that produce contributions on the frontend side. */
export const FRONTEND_SURFACES: readonly string[] = [
  'tool',
  'command',
  'api',
  'channel',
  'method',
  'tab',
  'dock',
  'setting',
  'slot',
  'fill',
  'action',
  'store',
  'activity-group',
  'leader',
];

/** Surfaces whose filename carries a relationship target. */
export const TARGETED_SURFACES: readonly string[] = ['fill', 'action'];

/** Surfaces whose folders below the surface spell a route path. */
export const ROUTED_SURFACES: readonly string[] = ['api'];

/** Source extensions the scan accepts. */
export const SOURCE_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'mts', 'cts'];

/** Filename infixes excluded everywhere, whatever their position. */
export const EXCLUDED_INFIXES: readonly string[] = ['test', 'spec', 'stories'];

/** Marks a folder as organisational: not a path segment, contents still scanned. */
export const GROUP_PREFIX = '(';
export const GROUP_SUFFIX = ')';
/** Marks a folder as private: never scanned, never built. */
export const PRIVATE_PREFIX = '_';
/** Marks a folder as a dynamic route segment. */
export const DYNAMIC_PREFIX = '[';
export const DYNAMIC_SUFFIX = ']';
/** Marks a dynamic segment as catch-all. */
export const CATCH_ALL_MARKER = '...';
