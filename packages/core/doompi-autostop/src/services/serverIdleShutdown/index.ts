import type { DoomHeadlessHostService, DoomHeadlessHook } from '@agimon-ai/doompi-core/headless';
import { DEFAULT_AUTO_STOP_DELAYS } from '../../constants/idlePolicy';
import { decideOnRecheck, decideOnSettled } from '../idlePolicy';
import type { ServerIdleShutdown } from './type';
export function createServerIdleShutdown(host: DoomHeadlessHostService): ServerIdleShutdown {
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
      void host.context.session
        .activity()
        .then((activity) => {
          if (!watching) return;
          const decision = decideOnRecheck(activity, DEFAULT_AUTO_STOP_DELAYS);
          if (decision.action === 'shutdown') host.context.shutdown();
          else if (decision.action === 'stand-down') stopWatching();
          else schedule(decision.delayMs);
        })
        .catch(() => stopWatching());
    }, delayMs);
  };

  const hooks: DoomHeadlessHook[] = [
    {
      event: 'agent_start',
      handle: stopWatching,
    },
    {
      event: 'agent_settled',
      async handle() {
        const decision = decideOnSettled(await host.context.session.activity(), DEFAULT_AUTO_STOP_DELAYS);
        if (decision.action === 'recheck') schedule(decision.delayMs);
        else stopWatching();
      },
    },
    {
      event: 'session_shutdown',
      handle: stopWatching,
    },
    {
      event: 'session_tree',
      async handle() {
        if (!watching) return;
        const decision = decideOnRecheck(await host.context.session.activity(), DEFAULT_AUTO_STOP_DELAYS);
        if (decision.action === 'shutdown') host.context.shutdown();
        else if (decision.action === 'stand-down') stopWatching();
        else schedule(decision.delayMs);
      },
    },
  ];
  return { hooks, dispose: stopWatching };
}
