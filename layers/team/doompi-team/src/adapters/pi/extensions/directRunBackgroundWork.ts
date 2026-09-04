import type {
  BackgroundProviderWorkItem,
  DoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import type { Context } from '@deepseek-ai/cordis';
import type { AsyncJobTracker } from '../../asyncJobTracker';

const PROVIDER_NAME = 'team-direct-runs';

/** Publish direct Team runs owned by exactly one Pi session. */
export function registerDirectRunBackgroundWork(
  ctx: Context,
  service: DoomBackgroundWorkService,
  sessionId: string,
  tracker: Pick<AsyncJobTracker, 'listBackgroundWork' | 'subscribe'>,
): void {
  const registration = service.register({
    provider: PROVIDER_NAME,
    listActiveWork: (): BackgroundProviderWorkItem[] =>
      tracker.listBackgroundWork(sessionId).map((job) => ({
        id: job.runId,
        sessionId,
        ...(job.agent ? { label: job.agent } : {}),
        ...(job.status ? { status: job.status } : {}),
      })),
  });
  const unsubscribe = tracker.subscribe(sessionId, () => registration.update());
  ctx.effect(
    () => () => {
      unsubscribe();
      registration.dispose();
    },
    '@agimon-ai/doompi-team/direct-run-background-work',
  );
}
