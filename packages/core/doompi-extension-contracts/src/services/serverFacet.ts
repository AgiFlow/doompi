/**
 * The server host a facet contributes to.
 *
 * DESIGN PATTERNS:
 * - One mount table. Every facet registers through this service, so the host
 *   process has a single ordered record of what is mounted and under what.
 * - Base paths are first-come. A collision is reported and skipped, so one
 *   misdeclared package cannot take a server down.
 * - Handlers are started lazily on first mount and closed on dispose, so a
 *   facet that registers and immediately unwinds leaves nothing running.
 *
 * AVOID:
 * - Letting a throwing `start` escape. A package whose API cannot start is
 *   reported and skipped; the remaining facets still mount.
 * - Reaching for node:*. The host owns the listener; this only owns the table.
 */

import type { DoomApi, DoomApiContext, DoomApiHandler, DoomApiScope } from '../schemas/packageApi.ts';
import type { DoomServerHostService, DoomServerRegistration } from '../schemas/serverFacet.ts';

interface MountedApi {
  readonly basePath: string;
  readonly handler: DoomApiHandler;
}

export interface CreateDoomServerHostOptions {
  scope: DoomApiScope;
  context: DoomApiContext;
  /** Called when a mount table entry appears or disappears, so a router can rebuild. */
  onChange?: (mounted: readonly string[]) => void;
}

/** The mount table a server host exposes to its facets, plus the router's read side. */
export interface DoomServerHost extends DoomServerHostService {
  /** The handler owning a base path, for the router that dispatches to it. */
  handlerFor(basePath: string): DoomApiHandler | undefined;
  /** Close every mounted handler and empty the table. */
  dispose(): void;
}

export function createDoomServerHost(options: CreateDoomServerHostOptions): DoomServerHost {
  const { scope, context } = options;
  const notice = (message: string): void => context.onNotice(message);
  const mounts: MountedApi[] = [];
  let disposed = false;

  const changed = (): void => options.onChange?.(mounts.map((mount) => mount.basePath));

  const noop: DoomServerRegistration = { mounted: false, dispose: () => undefined };

  const registerApi = (api: DoomApi): DoomServerRegistration => {
    if (disposed) {
      notice(`package API '${api.basePath}' is skipped: the server host is already disposed.`);
      return noop;
    }
    const holder = mounts.find((mount) => mount.basePath === api.basePath);
    if (holder !== undefined) {
      notice(`package API '${api.basePath}' is skipped: another facet already claims it.`);
      return noop;
    }
    let handler: DoomApiHandler;
    try {
      handler = api.start(context);
    } catch (error) {
      notice(`package API '${api.basePath}' did not start (${String(error)}); it is skipped.`);
      return noop;
    }
    const mount: MountedApi = { basePath: api.basePath, handler };
    mounts.push(mount);
    changed();
    let released = false;
    return {
      mounted: true,
      dispose: () => {
        if (released) return;
        released = true;
        const index = mounts.indexOf(mount);
        if (index >= 0) mounts.splice(index, 1);
        try {
          handler.close();
        } catch (error) {
          notice(`package API '${mount.basePath}' did not close cleanly (${String(error)}).`);
        }
        changed();
      },
    };
  };

  return {
    scope,
    context,
    registerApi,
    mounted: () => mounts.map((mount) => mount.basePath),
    handlerFor: (basePath) => mounts.find((mount) => mount.basePath === basePath)?.handler,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const mount of mounts.splice(0).reverse()) {
        try {
          mount.handler.close();
        } catch (error) {
          notice(`package API '${mount.basePath}' did not close cleanly (${String(error)}).`);
        }
      }
      changed();
    },
  };
}
