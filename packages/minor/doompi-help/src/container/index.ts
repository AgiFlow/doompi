import type { DoomHelpContribution, DoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DefaultHelpSkillMaterializer, defaultHelpCacheRoot, HelpIndexCache } from '../adapters/helpStorage.ts';
import { DefaultHelpIndexResolver } from '../adapters/llmsResolver.ts';
import { DefaultHelpActivationService } from '../services/helpActivation.ts';
import type { HelpFetch } from '../types/help.ts';

export interface HelpRuntimeOptions {
  cacheRoot?: string;
  fetch?: HelpFetch;
  timeoutMs?: number;
  onBackgroundError?(error: unknown): void;
}

export interface HelpRuntimeComposition {
  activation: DefaultHelpActivationService;
  dispose(): void;
}

function reportAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

export function createHelpRuntime(service: DoomHelpService, options: HelpRuntimeOptions = {}): HelpRuntimeComposition {
  const cacheRoot = options.cacheRoot ?? defaultHelpCacheRoot();
  const cache = new HelpIndexCache(cacheRoot);
  const activation = new DefaultHelpActivationService({
    resolver: new DefaultHelpIndexResolver({ cache, fetch: options.fetch, timeoutMs: options.timeoutMs }),
    materializer: new DefaultHelpSkillMaterializer(cacheRoot),
    publisher: { publish: (snapshot) => service.publish(snapshot) },
    onBackgroundError(error) {
      if (options.onBackgroundError) options.onBackgroundError(error);
      else reportAsync(error);
    },
  });
  const synchronize = (contributions: readonly DoomHelpContribution[]): void => {
    activation.replaceContributions(contributions);
  };
  const unsubscribe = service.subscribeContributions((contributions) => synchronize(contributions));
  synchronize(service.listContributions());
  let disposed = false;
  return {
    activation,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      activation.dispose();
    },
  };
}
