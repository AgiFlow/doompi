/**
 * Background-work registration for workflow runs.
 *
 * DESIGN PATTERNS:
 * - Hard dependency binding through Cordis injection
 * - Snapshot pattern: the extension pushes the current run set, the provider
 *   only reads it
 *
 * CODING STANDARDS:
 * - Named exports only
 * - Explicit return types on exported functions
 *
 * AVOID:
 * - Process-global symbols or dynamic imports for extension communication
 * - Reporting runs owned by another Pi session
 */

import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkProviderHandle,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import type { Context } from '@deepseek-ai/cordis';

export interface RunProviderItem {
  id: string;
  sessionId: string;
}

export interface RunProviderHandle {
  /** Replace the reported run set. */
  update(items: RunProviderItem[]): void;
  /** Remove the registration. Safe to call when registration never happened. */
  dispose(): void;
}

const PROVIDER_NAME = 'workflow-mcp';

/**
 * Register a background-work provider for this session's workflow runs.
 *
 * The runtime pins all announcements to the active Pi session and validates
 * each snapshot before it reaches another extension.
 */
export function registerRunProvider(ctx: Context): RunProviderHandle {
  let items: RunProviderItem[] = [];
  let provider: BackgroundWorkProviderHandle | undefined;
  let disposed = false;
  ctx.inject([DOOM_BACKGROUND_WORK_SERVICE], (serviceContext) => {
    if (disposed) return undefined;
    const service = readDoomBackgroundWorkService(serviceContext);
    if (!service) return undefined;
    const registration = service.register({ provider: PROVIDER_NAME, listActiveWork: () => items });
    provider = registration;
    return () => {
      registration.dispose();
      if (provider === registration) provider = undefined;
    };
  });
  const handle: RunProviderHandle = {
    update(next) {
      items = next;
      provider?.update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      items = [];
      provider?.dispose();
      provider = undefined;
    },
  };
  return handle;
}
