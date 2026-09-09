/**
 * The tool surface arbiter.
 *
 * DESIGN PATTERNS:
 * - One writer. Every owner registers a restriction; only this service calls
 *   the host setter. Two owners can no longer overwrite each other's list.
 * - Removal is inherent. The surface is recomputed from the full registered
 *   tool set on every change, so dropping a restriction restores the tools it
 *   hid without any owner keeping a snapshot.
 * - Restrictions are pure and ordered by registration. The result is a
 *   function of (registered tools, active layers, registered restrictions).
 * - Application is synchronous. A tool change has to be visible to the very
 *   next line, because callers gate user-facing messages on it. The kernel's
 *   coalesced flush still drives layer switches; it just lands on the same
 *   idempotent apply.
 *
 * AVOID:
 * - Letting one broken restriction take the surface down. A throwing
 *   restriction is skipped and reported; the rest still reach the host.
 * - Returning tool names the host does not know. Unknown names are dropped so
 *   a stale restriction cannot resurrect a tool that was never registered.
 */

import { createDoomKernel } from '@agimon-ai/doompi-kernel';
import type {
  DoomToolRestriction,
  DoomToolRestrictionDefinition,
  DoomToolRestrictionHandle,
  DoomToolSurfaceService,
} from '../schemas/toolSurface.ts';

const SLOT = 'tools';

interface RestrictionHolder {
  readonly source: string;
  restrict: DoomToolRestriction;
}

export interface CreateDoomToolSurfaceOptions {
  /** Runtime generation, mirrored onto the service for diagnostics. */
  readonly generation: string;
  /** Every tool registered with the host, in host order. */
  readonly allTools: () => readonly string[];
  /** The host's whole-list setter. Called only when the result changed. */
  readonly setActiveTools: (names: string[]) => void;
  /** Layers active at creation. */
  readonly activeLayers?: readonly string[];
  /** Receives a restriction that threw. Defaults to silence. */
  readonly onError?: (source: string, error: unknown) => void;
}

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

export function createDoomToolSurface(options: CreateDoomToolSurfaceOptions): DoomToolSurfaceService {
  const kernel = createDoomKernel({ activeLayers: options.activeLayers });
  let pushed: readonly string[] | undefined;
  let disposed = false;

  const apply = (holders: readonly RestrictionHolder[]): void => {
    const available = [...new Set(options.allTools())];
    const known = new Set(available);
    let current: readonly string[] = available;
    for (const holder of holders) {
      try {
        const result = holder.restrict(current, available);
        current = [...new Set(result)].filter((name) => known.has(name));
      } catch (error) {
        options.onError?.(holder.source, error);
      }
    }
    // Before the first push the host already has every registered tool active,
    // so an unrestricted surface must stay silent rather than echo the list back.
    const previous = pushed ?? available;
    pushed = current;
    if (sameList(previous, current)) return;
    options.setActiveTools([...current]);
  };

  const slot = kernel.defineSlot<RestrictionHolder>(SLOT, apply);
  const applyNow = (): void => {
    if (!disposed) apply(kernel.activeValues<RestrictionHolder>(SLOT));
  };

  return Object.freeze({
    generation: options.generation,
    register(definition: DoomToolRestrictionDefinition): DoomToolRestrictionHandle {
      if (definition.source.trim().length === 0) throw new Error('A tool restriction needs a source.');
      const holder: RestrictionHolder = { source: definition.source, restrict: definition.restrict };
      const registration = slot.contribute({ source: definition.source, layer: definition.layer, value: holder });
      applyNow();
      let removed = false;
      return Object.freeze({
        update(restrict: DoomToolRestriction): void {
          if (removed) return;
          holder.restrict = restrict;
          applyNow();
        },
        dispose(): void {
          if (removed) return;
          removed = true;
          registration.dispose();
          applyNow();
        },
      });
    },
    refresh(): void {
      applyNow();
    },
    setActiveLayers(layers: readonly string[]): void {
      if (disposed) return;
      void kernel.setActiveLayers(layers).catch(() => undefined);
      applyNow();
    },
    active(): readonly string[] {
      return pushed ?? [];
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      kernel.dispose();
    },
  });
}
