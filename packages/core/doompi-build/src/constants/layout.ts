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

/** The leaf filename of an HTTP route, as Next.js spells it. */
export const ROUTE_FILE_NAME = 'route';

/**
 * The reserved filename that constructs a scope, as Next.js spells a layout.
 *
 * One per scope and side. It runs before every contribution beneath it, and
 * whatever it returns is handed to each of them as part of the mount context,
 * which is how a package with one shared per-mount object graph decomposes
 * into a file per surface instead of one closure.
 */
export const ROOT_FILE_NAME = 'root';

/**
 * Where generated entries are written, package-relative.
 *
 * Not `src`. That directory is authored code, and a build that writes into it
 * makes every package carry output its author did not write and must not edit.
 * This one is gitignored per package, and the repository's formatter already
 * skips a directory by this name.
 */
export const GENERATED_DIR = 'generated';

/**
 * The generated entry each build target writes, keyed by the target it serves.
 *
 * Keyed rather than positional. The basenames are historical and two of the
 * three do not match their target's name, so an array has to be read by index,
 * and adding a fourth generated file silently rotates which host each entry
 * belongs to.
 */
export const GENERATED_ENTRY_FILENAMES = { cli: 'pi', server: 'server', web: 'web', mcp: 'mcp' } as const;

/**
 * The generated typed client, which is not a build target.
 *
 * Nothing bundles it as an entry: a `(frontend)` file imports it and the
 * cockpit's browser build pulls it in from there. It is listed among the
 * managed names so that a package which drops its route table has the stale
 * client deleted rather than left behind.
 */
export const GENERATED_CLIENT_NAME = 'client';

/**
 * The route table a package authors, and the switch that asks for a client.
 *
 * Its presence is what opts a package in, the way `src/exports/apiContracts.ts`
 * is what asks for a contracts entry. It lives under `src/types` because that
 * is one of the two source roots a browser bundle may read.
 */
export const API_ROUTES_MODULE = 'src/types/apiRoutes.ts';

/**
 * Every generated basename. Never scanned, never hand-edited.
 *
 * Spelled out rather than derived from the two declarations above, because a
 * constants module holds data a reader can see without running it. The cost is
 * that the names appear twice; the generate tests assert the two agree.
 */
export const GENERATED_ENTRY_NAMES: readonly string[] = ['pi', 'server', 'web', 'mcp', 'client'];

/**
 * Platform suffixes, scoped to their side. A target may not reuse one of these words.
 *
 * Every public routed file names one of these, so which host reads it is read
 * off the filename rather than inferred. A file that names none is a notice.
 *
 * `cli` appears on both sides, because the interactive host has both. Its
 * backend files hold a tool's `execute` and its services; its frontend files
 * hold the TUI that draws them. A terminal is a frontend that happens not to
 * be a browser, which is why the side axis is logic against presentation
 * rather than Node against browser.
 */
export const BACKEND_PLATFORMS: readonly string[] = ['cli', 'server', 'mcp'];
export const FRONTEND_PLATFORMS: readonly string[] = ['cli', 'web', 'ios', 'android', 'desktop'];

/** The hosts this build emits. A frontend platform outside this set is authorable but unbuildable. */
export const BUILD_TARGET_PLATFORMS: readonly string[] = ['cli', 'server', 'web', 'mcp'];

/**
 * Surfaces that produce contributions on the backend side.
 *
 * `mode` is absent on purpose: it is a gate folder, so it is consumed before
 * the surface check and its declaration file synthesises the surface instead.
 */
export const BACKEND_SURFACES: readonly string[] = [
  'tool',
  'skill',
  'tool-restriction',
  'command',
  'shortcut',
  'hook',
  'api',
  'channel',
  'method',
  'provider',
  'resource',
];

/**
 * Surfaces that produce contributions on the frontend side.
 *
 * `message` is terminal-only today: the cockpit renders a timeline entry
 * through a tool renderer or a fill, while the TUI has a separate registry
 * keyed by custom message type.
 */
export const FRONTEND_SURFACES: readonly string[] = [
  'tool',
  'command',
  'api',
  'channel',
  'method',
  'message',
  'overlay',
  'tab',
  'template',
  'dock',
  'setting',
  'slot',
  'fill',
  'action',
  'store',
  'activity-group',
  'leader',
  'selection-axis',
  'lifecycle',
  'file-links',
  'repository-settings-panel',
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
