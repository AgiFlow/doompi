import {
  BackgroundProviderWorkItemSchema,
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  type BackgroundWorkProvider,
  type BackgroundWorkProviderHandle,
  type DoomBackgroundWorkService,
  type DoomBackgroundWorkSnapshot,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import type { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';

interface ProviderRegistration {
  readonly token: symbol;
  readonly generation: string;
  readonly provider: BackgroundWorkProvider;
}

/** Creates Team's generation-bound, pull-based background-work registry. */
export function createBackgroundWorkService(ctx: Context): DoomBackgroundWorkService {
  const registrations = new Map<string, ProviderRegistration>();
  const generation = `doom-background-work:${crypto.randomUUID()}`;

  const changed = (
    provider: string,
    providerGeneration: string,
    kind: 'registered' | 'updated' | 'unregistered',
  ): void => {
    ctx.emit(DOOM_BACKGROUND_WORK_CHANGED_EVENT, { provider, generation: providerGeneration, kind });
  };

  const service: DoomBackgroundWorkService = {
    generation,
    register(provider): BackgroundWorkProviderHandle {
      if (!provider || typeof provider !== 'object' || typeof provider.listActiveWork !== 'function') {
        throw new TypeError('A background-work provider must expose listActiveWork().');
      }
      const name = provider.provider.trim();
      if (!name || name !== provider.provider) {
        throw new TypeError('A background-work provider requires a trimmed, non-empty name.');
      }
      const token = Symbol(name);
      const providerGeneration = `${name}:${crypto.randomUUID()}`;
      registrations.set(name, { token, generation: providerGeneration, provider });
      changed(name, providerGeneration, 'registered');
      let disposed = false;
      return Object.freeze({
        provider: name,
        generation: providerGeneration,
        update(): void {
          if (!disposed && registrations.get(name)?.token === token) {
            changed(name, providerGeneration, 'updated');
          }
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          if (registrations.get(name)?.token !== token) return;
          registrations.delete(name);
          changed(name, providerGeneration, 'unregistered');
        },
      });
    },
    snapshot(sessionId?: string): DoomBackgroundWorkSnapshot {
      const items: DoomBackgroundWorkSnapshot['items'][number][] = [];
      const errors: DoomBackgroundWorkSnapshot['errors'][number][] = [];
      for (const [provider, registration] of registrations) {
        try {
          const current = registration.provider.listActiveWork();
          if (!Array.isArray(current)) throw new TypeError('listActiveWork() must return an array.');
          for (const item of current) {
            if (!Check(BackgroundProviderWorkItemSchema, item)) {
              throw new TypeError('listActiveWork() returned an invalid item.');
            }
            if (sessionId === undefined || item.sessionId === sessionId) items.push({ provider, ...item });
          }
        } catch (error) {
          errors.push({ provider, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return Object.freeze({ items: Object.freeze(items), errors: Object.freeze(errors) });
    },
  };
  return Object.freeze(service);
}
