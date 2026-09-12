import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MinorModeOwner } from '../modeDefinition';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  requireMinorModeCatalog,
  type MinorModeOwnerActionContext,
  type MinorModeOwnerDefinition,
  type MinorModeOwnerHandle,
} from '../../schemas/mode';
import { registerMinorModeOwner } from '../owner';

type ModeRegistrar = (definition: MinorModeOwnerDefinition<ExtensionContext>) => MinorModeOwnerHandle;
export type PiMinorModeContribution =
  | MinorModeOwner<MinorModeOwnerActionContext<ExtensionContext>>
  | Parameters<ModeRegistrar>[0];
export interface PiMinorModeCollection {
  snapshot(): readonly PiMinorModeContribution[];
  subscribe(listener: () => void): () => void;
}

/** Registers static or live owners for the injected catalog's lifetime. */
export function piMinorModes(
  modes: readonly PiMinorModeContribution[] | PiMinorModeCollection | undefined,
): (context: Context) => void {
  return (context) => {
    if (!modes) return;
    context.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (child) => {
      const controller = new AbortController();
      const signal = controller.signal;
      child.effect(() => () => controller.abort());
      const catalog = requireMinorModeCatalog(child);
      const mounted = new Map<string, { declaration: PiMinorModeContribution; release(): void }>();
      let disposed = false;
      let reconciling = false;
      let pending = false;
      let subscribing = true;
      const reconcile = (): void => {
        pending = true;
        if (disposed || signal.aborted || subscribing || reconciling) return;
        reconciling = true;
        try {
          do {
            pending = false;
            const snapshot = 'snapshot' in modes ? modes.snapshot() : modes;
            const next = new Map<string, PiMinorModeContribution>();
            for (const declaration of snapshot) {
              const definition = 'definition' in declaration ? declaration.definition : declaration;
              const key = JSON.stringify([definition.descriptor.source, definition.descriptor.id]);
              if (next.has(key))
                throw new Error(
                  `Duplicate live minor mode: ${definition.descriptor.source}/${definition.descriptor.id}`,
                );
              next.set(key, declaration);
            }
            for (const [key, entry] of mounted) {
              if (next.get(key) === entry.declaration) continue;
              mounted.delete(key);
              entry.release();
            }
            for (const [key, declaration] of next) {
              if (mounted.has(key)) continue;
              const owner = 'definition' in declaration ? declaration : undefined;
              const handle = registerMinorModeOwner(
                catalog,
                owner ? owner.definition : (declaration as Parameters<ModeRegistrar>[0]),
              );
              mounted.set(key, {
                declaration,
                release() {
                  try {
                    owner?.detach();
                  } finally {
                    handle.dispose();
                  }
                },
              });
              owner?.attach(handle);
            }
          } while (pending && !disposed && !signal.aborted);
        } finally {
          reconciling = false;
        }
      };
      child.effect(() => () => {
        disposed = true;
        const entries = [...mounted.values()];
        mounted.clear();
        const errors: unknown[] = [];
        for (const entry of entries) {
          try {
            entry.release();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Minor mode cleanup failed.');
      });
      if ('subscribe' in modes) {
        const unsubscribe = modes.subscribe(reconcile);
        child.effect(() => () => {
          disposed = true;
          unsubscribe();
        });
      }
      subscribing = false;
      reconcile();
    });
  };
}
