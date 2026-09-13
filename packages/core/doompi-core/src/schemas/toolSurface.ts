import type { Context } from '@deepseek-ai/cordis';

/** Session-scoped arbiter that owns the active Pi tool list. */
export const DOOM_TOOL_SURFACE_SERVICE = 'doom/tool-surface';

/**
 * Narrows the tool list handed to it.
 *
 * `available` is every tool registered with the host. `incoming` is the list
 * produced by the restrictions registered before this one. Return a new list;
 * returning `incoming` unchanged is the no-op.
 */
export type DoomToolRestriction = (incoming: readonly string[], available: readonly string[]) => readonly string[];

export interface DoomToolRestrictionDefinition<TRestriction = DoomToolRestriction> {
  /** Package-unique owner label, used for diagnostics and ordering ties. */
  readonly source: string;
  /** Layer that owns this restriction, gated by the kernel when set. */
  readonly layer?: string;
  readonly restrict: TRestriction;
  subscribe?(listener: () => void): () => void;
}

export interface DoomToolRestrictionHandle {
  /** Swap the restriction in place and reapply, keeping registration order. */
  update(restrict: DoomToolRestriction): void;
  /** Drop the restriction and reapply. The previous surface returns by itself. */
  dispose(): void;
}

/**
 * The only writer of the host's active tool list.
 *
 * Owners register a restriction instead of snapshotting and restoring the tool
 * list themselves. Removal is inherent: dropping a restriction recomputes the
 * surface from the full set of registered tools, so no owner has to remember
 * what the list looked like before it started.
 */
export interface DoomToolSurfaceService {
  readonly generation: string;
  register(definition: DoomToolRestrictionDefinition): DoomToolRestrictionHandle;
  /** Recompute and push. Call when the registered tool set itself changed. */
  refresh(): void;
  /** Layers currently active; restrictions owned by other layers stay dormant. */
  setActiveLayers(layers: readonly string[]): void;
  /** The list most recently reconciled with the host. */
  active(): readonly string[];
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/tool-surface': DoomToolSurfaceService;
  }
}

export function readDoomToolSurface(context: Context): DoomToolSurfaceService | undefined {
  return context.get(DOOM_TOOL_SURFACE_SERVICE) as DoomToolSurfaceService | undefined;
}

export function requireDoomToolSurface(context: Context): DoomToolSurfaceService {
  const service = readDoomToolSurface(context);
  if (!service) throw new Error('The Doom tool surface is unavailable. Start a Doom runtime first.');
  return service;
}
