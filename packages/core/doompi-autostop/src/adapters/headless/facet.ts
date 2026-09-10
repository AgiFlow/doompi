import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessHook,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_AUTO_STOP_DELAYS, decideOnRecheck, decideOnSettled } from '../../services/idlePolicy.ts';

/** Headless auto-stop keeps shutdown policy in the session host, not in a Pi adapter. */
export const autoStopHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watching = false;

    const stopWatching = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watching = false;
    };
    const schedule = (delayMs: number): void => {
      stopWatching();
      watching = true;
      timer = setTimeout(() => {
        timer = undefined;
        if (!watching) return;
        // The headless session owns the authoritative idle state. A settled event
        // only starts the grace period; the host shutdown remains explicit here.
        host.context.shutdown();
      }, delayMs);
    };

    const hooks: DoomHeadlessHook[] = [
      {
        event: 'agent_settled',
        handle(event) {
          const decision = decideOnSettled(
            {
              hasPendingMessages: event.hasPendingMessages === true,
              isIdle: event.isIdle === true,
            },
            DEFAULT_AUTO_STOP_DELAYS,
          );
          if (decision.action === 'recheck') schedule(decision.delayMs);
          else stopWatching();
        },
      },
      {
        event: 'session_shutdown',
        handle() {
          stopWatching();
        },
      },
      {
        event: 'session_tree',
        handle(event) {
          if (!watching) return;
          const decision = decideOnRecheck(
            {
              hasPendingMessages: event.hasPendingMessages === true,
              isIdle: event.isIdle === true,
            },
            DEFAULT_AUTO_STOP_DELAYS,
          );
          if (decision.action === 'shutdown') host.context.shutdown();
          else if (decision.action === 'stand-down') stopWatching();
          else schedule(decision.delayMs);
        },
      },
    ];
    const registrations = hooks.map((hook) => host.registerHook(hook));
    return () => {
      stopWatching();
      for (const registration of registrations) registration.dispose();
    };
  },
};
