import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { AUTO_STOP_ACTION } from '../../constants/idlePolicy';
import type { AutostopDiagnostics } from '../autostopDiagnostics/type';
import type { BackgroundWorkSummary } from '../backgroundWorkGate';
import { decideOnRecheck, decideOnSettled } from '../idlePolicy';
import type { AutoStopDelays, SessionActivity } from '../idlePolicy/type';
import type { IdleShutdown } from './type';

const NO_WORK: BackgroundWorkSummary = Object.freeze({ active: false, items: [], errors: [] });

function readActivity(context: ExtensionContext): SessionActivity {
  return { hasPendingMessages: context.hasPendingMessages(), isIdle: context.isIdle() };
}
export function createIdleShutdown(
  delays: AutoStopDelays,
  inspectBackgroundWork: (context: ExtensionContext) => BackgroundWorkSummary = () => NO_WORK,
  diagnostics?: Pick<AutostopDiagnostics, 'waiting' | 'stoodDown' | 'shutdownRequested' | 'reset'>,
): IdleShutdown {
  let shutdownTimer: NodeJS.Timeout | undefined;

  const cancelScheduledShutdown = (): void => {
    diagnostics?.reset();
    if (!shutdownTimer) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  const scheduleShutdown = (context: ExtensionContext, delayMs: number): void => {
    shutdownTimer = setTimeout(() => {
      shutdownTimer = undefined;
      const work = inspectBackgroundWork(context);
      if (work.active) {
        diagnostics?.waiting(work);
        scheduleShutdown(context, delays.cooldownMs);
        return;
      }
      const decision = decideOnRecheck(readActivity(context), delays);
      if (decision.action === AUTO_STOP_ACTION.shutdown) {
        diagnostics?.shutdownRequested();
        context.shutdown();
        return;
      }
      if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
      else diagnostics?.stoodDown();
    }, delayMs);
  };

  return {
    cancel: cancelScheduledShutdown,
    settled(context) {
      cancelScheduledShutdown();
      const decision = decideOnSettled(readActivity(context), delays);
      if (decision.action === AUTO_STOP_ACTION.recheck) scheduleShutdown(context, decision.delayMs);
      else diagnostics?.stoodDown();
    },
  };
}
