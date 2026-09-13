import {
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/background-work';
import type { Context } from '@deepseek-ai/cordis';

export interface BackgroundWorkGate {
  readonly plugin: (context: Context) => void;
  hasActiveWork(sessionId: string): boolean;
}

/** Tracks the current background-work coordinator and fails closed when its snapshot is uncertain. */
export function createBackgroundWorkGate(): BackgroundWorkGate {
  let backgroundWork: DoomBackgroundWorkService | undefined;
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
    hasActiveWork(sessionId) {
      if (!backgroundWork) return false;
      try {
        const snapshot = backgroundWork.snapshot(sessionId);
        return snapshot.items.length > 0 || snapshot.errors.length > 0;
      } catch {
        return true;
      }
    },
  };
}
