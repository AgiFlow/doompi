import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  AUTO_STOP_ACTION,
  type AutoStopDelays,
  type SessionActivity,
  decideOnRecheck,
  decideOnSettled,
} from '../../services/idlePolicy.ts';

function readActivity(context: ExtensionContext): SessionActivity {
  return { hasPendingMessages: context.hasPendingMessages(), isIdle: context.isIdle() };
}

/**
 * Watches the session for idleness and returns the disposer for that watch.
 *
 * Pi's `on` hands back nothing to unsubscribe with, so the only resource this
 * owns across a reload is the armed timer — and an armed timer is the one that
 * matters, because firing it would stop the session Pi has just reloaded into.
 */
export function registerIdleShutdown(pi: ExtensionAPI, delays: AutoStopDelays): () => void {
  let shutdownTimer: NodeJS.Timeout | undefined;

  const cancelScheduledShutdown = (): void => {
    if (!shutdownTimer) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  const scheduleShutdown = (context: ExtensionContext, delayMs: number): void => {
    shutdownTimer = setTimeout(() => {
      shutdownTimer = undefined;
      const decision = decideOnRecheck(readActivity(context), delays);
      if (decision.action === AUTO_STOP_ACTION.shutdown) {
        context.shutdown();
        return;
      }
      if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
    }, delayMs);
  };

  pi.on('input', cancelScheduledShutdown);
  pi.on('agent_start', cancelScheduledShutdown);

  pi.on('agent_settled', (_event, context) => {
    cancelScheduledShutdown();
    const decision = decideOnSettled(readActivity(context), delays);
    if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
  });

  return cancelScheduledShutdown;
}
