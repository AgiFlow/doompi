import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import {
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HookTelemetry } from '../../types/telemetry';
import { createHookDocumentReader } from '../hookDocuments';
import { createBashHookRunner } from '../hookRunner';
import { createHookTelemetry } from '../hookTelemetry';
import { type HookReadinessGate, type HookSession } from './type';

import { PACKAGE_SOURCE } from '../../constants/hook';
import type { HookBinding, HookExtensionOptions, HookRuntimeBinding } from './type';

function hookSession(cordis: Context, options: HookExtensionOptions): HookSession {
  // The log sink is only built if something actually reports to it, so a fully
  // stubbed session never touches the telemetry backend.
  let telemetry = options.telemetry;
  const requireTelemetry = (): HookTelemetry => (telemetry ??= createHookTelemetry());
  return {
    config: () => requireDoomConfigContext(cordis),
    runner: options.runner ?? createBashHookRunner({ telemetry: requireTelemetry() }),
    documents: options.documents ?? createHookDocumentReader({ telemetry: requireTelemetry() }),
  };
}

function createHookRuntime(cordis: Context, options: HookExtensionOptions): HookRuntimeBinding {
  const session = hookSession(cordis, options);
  let active = true;
  let generation = 0;
  let readiness:
    | {
        readonly sessionManager: object;
        readonly coordinator: DoomReadinessCoordinator;
        readonly operation: Promise<void>;
      }
    | undefined;
  const readinessGate: HookReadinessGate = {
    start(context, operation) {
      const ownGeneration = ++generation;
      const isCurrent = (): boolean => active && ownGeneration === generation;
      const coordinator = readDoomReadinessCoordinator(cordis);
      if (!coordinator) return operation(new AbortController().signal, isCurrent);

      const previous = readiness;
      const readinessOperation = (async (): Promise<void> => {
        if (previous?.coordinator === coordinator) await previous.operation.catch(() => undefined);
        if (!isCurrent()) return;
        const handle = coordinator.start(
          PACKAGE_SOURCE,
          `${context.sessionManager.getSessionId()}:${ownGeneration}`,
          async (signal) => {
            await operation(signal, isCurrent);
            return { value: undefined };
          },
        );
        await handle.wait();
      })();
      // Config's coordinator owns the single user-facing failure notification.
      void readinessOperation.catch(() => undefined);
      readiness = {
        sessionManager: context.sessionManager,
        coordinator,
        operation: readinessOperation,
      };
      return undefined;
    },
    async wait(context: ExtensionContext): Promise<void> {
      const current = readiness;
      if (!current) return;
      if (current.sessionManager !== context.sessionManager) {
        throw new Error('Hook readiness belongs to a stale Pi session.');
      }
      await current.operation;
      if (!active || current !== readiness) {
        throw new Error('Hook readiness belongs to a stale extension generation.');
      }
    },
  };
  return {
    session,
    readiness: readinessGate,
    isCurrent: () => active,
    dispose() {
      active = false;
      generation += 1;
      readiness = undefined;
    },
  };
}

export function createHookBinding(options: HookExtensionOptions): HookBinding {
  let runtime: HookRuntimeBinding | undefined;
  return {
    plugin(cordis) {
      cordis.inject([DOOM_CONFIG_SERVICE], (configContext) => {
        const binding = createHookRuntime(configContext, options);
        runtime = binding;
        return () => {
          binding.dispose();
          if (runtime === binding) runtime = undefined;
        };
      });
    },
    runtime: () => runtime,
  };
}
