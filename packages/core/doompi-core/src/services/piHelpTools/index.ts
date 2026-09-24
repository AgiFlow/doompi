import type { Context } from '@deepseek-ai/cordis';

import { DOOM_HELP_SERVICE, requireDoomHelpService } from '../../schemas/help';
import { DOOM_HELP_WHEN } from '../../schemas/help';
import {
  DOOM_TOOL_SURFACE_SERVICE,
  requireDoomToolSurface,
  type DoomToolSurfaceService,
} from '../../schemas/toolSurface';

/** Keep package-owned Pi tools closed when Help or its session provider is absent. */
export function createPiHelpToolGate(source: string, names: readonly string[]) {
  const controlled = new Set(names);
  let active: AbortController | undefined;
  let surface: DoomToolSurfaceService | undefined;
  let refresh = () => {};
  const deactivate = () => {
    active?.abort(new Error('Help tools are no longer active.'));
    active = undefined;
  };
  const bind = (context: Context): void => {
    context.inject([DOOM_TOOL_SURFACE_SERVICE], (child) => {
      const current = requireDoomToolSurface(child);
      surface = current;
      const restrict = (incoming: readonly string[]) =>
        active ? incoming : incoming.filter((name) => !controlled.has(name));
      const registration = current.register({
        source,
        controlledTools: [...controlled],
        attribution: DOOM_HELP_WHEN.attribution,
        restrict,
      });
      refresh = () => registration.update(restrict);
      // This restriction outlives the Help binding. Removing Help must not restore its tools.
      child.inject([DOOM_HELP_SERVICE], (helpContext) => {
        const help = requireDoomHelpService(helpContext);
        const synchronize = () => {
          const state = help.getSnapshot().activation;
          if (state === 'active' || state === 'degraded') active ??= new AbortController();
          else deactivate();
          registration.update(restrict);
        };
        const unsubscribe = help.subscribeSnapshot(synchronize);
        synchronize();
        return () => {
          unsubscribe();
          deactivate();
          registration.update(restrict);
        };
      });
      return () => {
        deactivate();
        if (surface === current) {
          surface = undefined;
          refresh = () => {};
        }
        registration.dispose();
      };
    });
  };
  return {
    services: [bind],
    // Native tools have been registered by this point, including a late package mount.
    onStart(this: void) {
      refresh();
    },
    assertActive(name: string, signal?: AbortSignal): AbortSignal {
      signal?.throwIfAborted();
      if (!controlled.has(name) || !active || !surface?.active().includes(name))
        throw new Error(`Help tool '${name}' is inactive or restricted.`);
      active.signal.throwIfAborted();
      return signal ? AbortSignal.any([signal, active.signal]) : active.signal;
    },
  };
}
