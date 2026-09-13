import { resolveVoiceConfig } from '@agimon-ai/doompi-config/config';
import type { DoomConfigContributionHandle } from '@agimon-ai/doompi-core/config';
import type { DoomFooterContributionHandle } from '@agimon-ai/doompi-core/footer';
import type { DoomLeaderContributionHandle, LeaderBinding } from '@agimon-ai/doompi-core/leader';
import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { type DoomReadinessCoordinator, readDoomReadinessCoordinator } from '@agimon-ai/doompi-core/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createVoiceDependencies } from '../services/voiceDependencies';
import { createVoiceRuntime, voiceLeaderBindings, type VoiceExtensionOptions } from './voice';
import { VoiceConfigController } from './voiceConfig';

const PACKAGE_SOURCE = '@agimon-ai/doompi-voice';
const FOOTER_ID = 'voice-activity';
const FOOTER_ORDER = 30;

async function waitForOperation(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Voice readiness wait was aborted.');
  }
  let rejectAborted: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    rejectAborted?.(signal.reason instanceof Error ? signal.reason : new Error('Voice readiness wait was aborted.'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createVoicePiRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  options: VoiceExtensionOptions,
): PiPluginContributions<VoiceExtensionOptions> {
  const dependencies = options.dependencies ?? createVoiceDependencies({ clientMedia: options.clientMedia });
  let active = true;
  let generation = 0;
  let readiness:
    | {
        readonly sessionManager: object;
        readonly coordinator: DoomReadinessCoordinator;
        readonly operation: Promise<void>;
      }
    | undefined;
  const waitUntilConfigured = async (
    context: { readonly sessionManager: object },
    signal?: AbortSignal,
  ): Promise<void> => {
    const current = readiness;
    if (!current) return;
    if (current.sessionManager !== context.sessionManager) {
      throw new Error('Voice configuration readiness belongs to a stale Pi session.');
    }
    await waitForOperation(current.operation, signal);
    if (!active || current !== readiness) {
      throw new Error('Voice configuration readiness belongs to a stale extension generation.');
    }
  };
  let activeFooter: DoomFooterContributionHandle | undefined;
  const footer: DoomFooterContributionHandle = {
    update: (value) => activeFooter?.update(value),
    dispose: () => {
      activeFooter?.dispose();
      activeFooter = undefined;
    },
  };
  let activeLeader: DoomLeaderContributionHandle | undefined;
  const leader = { update: (bindings: readonly LeaderBinding[]) => activeLeader?.update(bindings) };
  const runtime = createVoiceRuntime(pi, {
    ...options,
    footer,
    leader,
    dependencies,
    waitUntilConfigured,
  });
  const configs = dependencies.configs;
  let contribution: DoomConfigContributionHandle | undefined;
  let configSessionCtx: ExtensionContext | undefined;
  const voiceConfig = new VoiceConfigController(
    {
      resolver: dependencies.executables,
      spawner: dependencies.spawner,
      loadVoice: () => {
        const root = process.env.PI_PROJECT_ROOT ?? process.cwd();
        const loaded = configs.load(root).voice;
        return loaded ? resolveVoiceConfig(loaded) : undefined;
      },
      // Read from the live session, so the panel offers the models this
      // session can actually reach rather than a list compiled in here.
      listModels: () => {
        const registry = configSessionCtx?.modelRegistry;
        if (!registry) return [];
        return registry
          .getAvailable()
          .filter((model) => registry.hasConfiguredAuth(model))
          .map((model) => ({ provider: model.provider, id: model.id }));
      },
    },
    () => contribution?.update(),
  );

  return {
    ...runtime,
    async onStop(context) {
      active = false;
      generation += 1;
      readiness = undefined;
      await runtime.onStop?.(context);
    },
    services: [
      ...(runtime.services ?? []),
      {
        apply(cordis: Context) {
          cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
            const hub = requireDoomUiHub(uiContext);
            const footerContribution = hub.registerFooter({
              source: PACKAGE_SOURCE,
              id: FOOTER_ID,
              order: FOOTER_ORDER,
            });
            const leaderContribution = hub.registerLeader({
              source: PACKAGE_SOURCE,
              bindings: voiceLeaderBindings(false),
            });
            const configContribution = hub.registerConfig({
              source: PACKAGE_SOURCE,
              listSections: () => voiceConfig.sections(),
              handlers: voiceConfig.handlers(),
              onError: (error) => voiceConfig.reportError(error),
            });
            activeFooter = footerContribution;
            activeLeader = leaderContribution;
            contribution = configContribution;
            return () => {
              footerContribution.dispose();
              leaderContribution.dispose();
              configContribution.dispose();
              if (activeFooter === footerContribution) activeFooter = undefined;
              if (activeLeader === leaderContribution) activeLeader = undefined;
              if (contribution === configContribution) contribution = undefined;
            };
          });
          cordis.effect(() => () => {
            active = false;
            generation += 1;
            readiness = undefined;
            activeFooter = undefined;
            activeLeader = undefined;
            contribution = undefined;
          });
        },
      },
    ],
    events: {
      ...runtime.events,
      async session_start(event, context) {
        await runtime.events?.session_start?.(event, context);
        await ((_event, context) => {
          if (!active) return undefined;
          configSessionCtx = context;
          const ownGeneration = ++generation;
          const initialize = async (signal?: AbortSignal): Promise<void> => {
            signal?.throwIfAborted();
            await voiceConfig.refresh();
            signal?.throwIfAborted();
            if (active && ownGeneration === generation) contribution?.update();
          };
          const coordinator = readDoomReadinessCoordinator(cordis);
          if (!coordinator || !context) return initialize();

          const previous = readiness;
          const operation = (async (): Promise<void> => {
            if (previous?.coordinator === coordinator) await previous.operation.catch(() => undefined);
            if (!active || ownGeneration !== generation) return;
            const handle = coordinator.start(
              PACKAGE_SOURCE,
              `${context.sessionManager.getSessionId()}:${ownGeneration}`,
              async (signal) => {
                await initialize(signal);
                return { value: undefined };
              },
            );
            await handle.wait();
          })();
          // Config's coordinator owns the single user-facing failure notification.
          void operation.catch(() => undefined);
          readiness = { sessionManager: context.sessionManager, coordinator, operation };
          return undefined;
        })(event, context);
      },
    },
  };
}
