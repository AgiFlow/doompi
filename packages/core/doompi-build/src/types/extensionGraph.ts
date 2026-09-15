/** The scopes a contribution can mount at, in nesting order. */
export type ExtensionScope = 'global' | 'workspace' | 'session';

/** Which half of the package a contribution belongs to. */
export type ExtensionSide = 'backend' | 'frontend';

/** One gate folder and the id it names. */
export interface ExtensionGate {
  readonly kind: string;
  readonly id: string;
}

/** One dynamic route segment, as Next.js spells it. */
export interface RouteParam {
  readonly name: string;
  readonly catchAll: boolean;
}

/** One route segment below a routed surface: a literal, or a parameter. */
export type RouteSegment = { readonly literal: string } | { readonly param: RouteParam };

/**
 * One scanned file and everything its path declares about it.
 *
 * The scan produces these and nothing else. Turning them into host
 * contributions is the generator's job, so this stays a description of the
 * tree rather than of any one host.
 */
export interface ExtensionEntry {
  /** Package-relative POSIX path. */
  readonly file: string;
  readonly scope: ExtensionScope;
  readonly side: ExtensionSide;
  /** Gates wrapping this contribution, outermost first. */
  readonly gates: readonly ExtensionGate[];
  /** Surface folder, such as `tool`. Absent for the escape hatch. */
  readonly surface: string | undefined;
  /** Route path below a routed surface. Empty for every other surface. */
  readonly route: readonly RouteSegment[];
  /** Contribution identity, from the filename. */
  readonly name: string;
  /** Relationship target, such as the slot a fill names. */
  readonly target: string | undefined;
  /** Platform this file serves, or undefined for the side's neutral file. */
  readonly platform: string | undefined;
  /** True when this is a side's `extra.*` escape hatch. */
  readonly escapeHatch: boolean;
}

/** Something the scan skipped, and why. Never fatal. */
export interface ExtensionNotice {
  /** Package-relative POSIX path of the file or folder skipped. */
  readonly path: string;
  readonly message: string;
}

/** Everything one package's routing root declares. */
export interface ExtensionGraph {
  /** Package-relative POSIX path of the routing root that was scanned. */
  readonly root: string;
  readonly entries: readonly ExtensionEntry[];
  readonly notices: readonly ExtensionNotice[];
}
