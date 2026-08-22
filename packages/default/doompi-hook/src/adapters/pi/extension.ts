import {
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HookDocumentReader, HookRunner } from '../../types/hooks.ts';
import type { HookTelemetry } from '../../types/telemetry.ts';
import { createHookDocumentReader } from '../hookDocuments.ts';
import { createBashHookRunner } from '../hookRunner.ts';
import { createHookTelemetry } from '../telemetry/logSinkTelemetry.ts';
import {
  type HookReadinessGate,
  type HookRuntime,
  type HookSession,
  registerHookHandlers,
  runSessionEndHooks,
} from './hookHandlers.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-hook';

export interface HookExtensionOptions {
  telemetry?: HookTelemetry;
  runner?: HookRunner;
  documents?: HookDocumentReader;
}

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

interface HookPluginConfig {
  readonly pi: ExtensionAPI;
  readonly options: HookExtensionOptions;
}

interface HookRuntimeBinding extends HookRuntime {
  dispose(): void;
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

function hookPlugin(cordis: Context, { pi, options }: HookPluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-hook',
          description:
            'Author DoomPi repository or plugin hooks. Use when creating or changing .doom/hooks.yaml, selecting hook groups from modes.yaml, writing hook commands, or adapting Claude Code hook payloads and decisions to DoomPi.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  let runtime: HookRuntimeBinding | undefined;
  cordis.inject([DOOM_CONFIG_SERVICE], (configContext) => {
    const binding = createHookRuntime(configContext, options);
    runtime = binding;
    configContext.effect(
      () => () => {
        binding.dispose();
        if (runtime === binding) runtime = undefined;
      },
      `${PACKAGE_SOURCE}/config-runtime`,
    );
  });

  cordis.effect(function* () {
    for (const disposeRegistration of registerHookHandlers(pi, () => runtime)) yield disposeRegistration;
    yield () => {
      runtime = undefined;
    };
  }, PACKAGE_SOURCE);

  let shutdown: Promise<void> | undefined;
  pi.on('session_shutdown', (_event, ctx) => {
    const current = runtime;
    if (!current?.isCurrent()) return undefined;
    shutdown ??= runSessionEndHooks(current.session, ctx);
    return shutdown;
  });
}

/** The package's single standard Pi factory. */
export async function hookExtension(pi: ExtensionAPI, options: HookExtensionOptions = {}): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(hookPlugin, { pi, options });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default hookExtension;
