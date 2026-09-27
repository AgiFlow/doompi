import {
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
  type BackgroundWorkItem,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/backgroundWork';
import type { Context } from '@deepseek-ai/cordis';

import {
  AUTO_STOP_BLOCKING_PROVIDERS,
  AUTO_STOP_RUNNER_PROVIDER,
  AUTO_STOP_RUNNER_WORKING_STATUS,
} from '../../constants/idlePolicy';

/** What is holding a session open, named so a stuck shutdown can say why. */
export interface BackgroundWorkSummary {
  readonly active: boolean;
  /** `provider:id` for each item the session still owns. */
  readonly items: readonly string[];
  /** `provider: message` for each provider whose snapshot failed. */
  readonly errors: readonly string[];
}

export interface BackgroundWorkGate {
  readonly plugin: (context: Context) => void;
  hasActiveWork(sessionId: string): boolean;
  inspect(sessionId: string): BackgroundWorkSummary;
}

function holdsSessionOpen(item: BackgroundWorkItem): boolean {
  if (!AUTO_STOP_BLOCKING_PROVIDERS.includes(item.provider)) return false;
  // Every runner item carries its state; one without it is not known to be done.
  if (item.provider !== AUTO_STOP_RUNNER_PROVIDER || item.status === undefined) return true;
  return item.status === AUTO_STOP_RUNNER_WORKING_STATUS;
}

const NO_WORK: BackgroundWorkSummary = Object.freeze({ active: false, items: [], errors: [] });

/**
 * Tracks the current background-work coordinator. Only runners and subagents
 * count, and it fails closed when their snapshot is uncertain.
 */
export function createBackgroundWorkGate(): BackgroundWorkGate {
  let backgroundWork: DoomBackgroundWorkService | undefined;
  const inspect = (sessionId: string): BackgroundWorkSummary => {
    if (!backgroundWork) return NO_WORK;
    try {
      const snapshot = backgroundWork.snapshot(sessionId);
      const items = snapshot.items.filter(holdsSessionOpen).map((item) => `${item.provider}:${item.id}`);
      const errors = snapshot.errors
        .filter((error) => AUTO_STOP_BLOCKING_PROVIDERS.includes(error.provider))
        .map((error) => `${error.provider}: ${error.message}`);
      return { active: items.length > 0 || errors.length > 0, items, errors };
    } catch (error) {
      return {
        active: true,
        items: [],
        errors: [`snapshot: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  };
  return {
    plugin: (context) => {
      context.inject([DOOM_BACKGROUND_WORK_SERVICE], (serviceContext) => {
        const service = readDoomBackgroundWorkService(serviceContext);
        if (!service) return undefined;
        backgroundWork = service;
        return () => {
          if (backgroundWork === service) backgroundWork = undefined;
        };
      });
    },
    hasActiveWork: (sessionId) => inspect(sessionId).active,
    inspect,
  };
}
