import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { AUTO_STOP_ACTION } from '../../constants/idlePolicy';
import { decideOnRecheck, decideOnSettled } from '../idlePolicy';
import type { AutoStopDelays, SessionActivity } from '../idlePolicy/type';
import type { IdleShutdown } from './type';
function readActivity(context: ExtensionContext): SessionActivity {
  return { hasPendingMessages: context.hasPendingMessages(), isIdle: context.isIdle() };
}
export function createIdleShutdown(
  delays: AutoStopDelays,
  hasActiveBackgroundWork: (context: ExtensionContext) => boolean = () => false,
): IdleShutdown {
  let shutdownTimer: NodeJS.Timeout | undefined;

  const cancelScheduledShutdown = (): void => {
    if (!shutdownTimer) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  const scheduleShutdown = (context: ExtensionContext, delayMs: number): void => {
    shutdownTimer = setTimeout(() => {
      shutdownTimer = undefined;
      if (hasActiveBackgroundWork(context)) {
        scheduleShutdown(context, delays.cooldownMs);
        return;
      }
      const decision = decideOnRecheck(readActivity(context), delays);
      if (decision.action === AUTO_STOP_ACTION.shutdown) {
        context.shutdown();
        return;
      }
      if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
    }, delayMs);
  };

  return {
    cancel: cancelScheduledShutdown,
    settled(context) {
      cancelScheduledShutdown();
      const decision = decideOnSettled(readActivity(context), delays);
      if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
    },
  };
}
