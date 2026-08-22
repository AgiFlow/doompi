import { resolveVoiceConfig } from '@agimon-ai/doompi-config/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import {
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import type { DoomConfigContributionHandle } from '@agimon-ai/doompi-extension-contracts/config';
import type { DoomFooterContributionHandle } from '@agimon-ai/doompi-extension-contracts/footer';
import type { DoomLeaderContributionHandle, LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { VoiceConfigController } from '../../adapters/pi/voiceConfig';
import { createVoiceContainer, installVoiceRuntime, voiceLeaderBindings } from './voice.ts';

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

interface VoicePluginConfig {
  readonly pi: ExtensionAPI;
}

function voicePlugin(cordis: Context, { pi }: VoicePluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-voice',
          description:
            'Use Doom Pi Voice for manual transcription, autonomous capture, narration, configuration, and recovery on macOS.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  cordis.effect(function* () {
    const container = createVoiceContainer();
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
    // Same indirection as the footer: the runtime is installed before the UI hub
    // is available, so it holds a proxy and the real contribution is swapped in
    // when the hub injects. A republish before then is a no-op, not a crash.
    let activeLeader: DoomLeaderContributionHandle | undefined;
    const leader = { update: (bindings: readonly LeaderBinding[]) => activeLeader?.update(bindings) };

    installVoiceRuntime(cordis, pi, { footer, leader, container, waitUntilConfigured });

    const configs = container.configs;
    let contribution: DoomConfigContributionHandle | undefined;
    /** The session context, kept only to read its model registry for the config panel. */
    let configSessionCtx: ExtensionContext | undefined;
    const voiceConfig = new VoiceConfigController(
      {
        resolver: container.executables,
        spawner: container.spawner,
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
    cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
      const hub = requireDoomUiHub(uiContext);
      const footerContribution = hub.registerFooter({ source: PACKAGE_SOURCE, id: FOOTER_ID, order: FOOTER_ORDER });
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
    yield () => {
      active = false;
      generation += 1;
      readiness = undefined;
      activeFooter = undefined;
      activeLeader = undefined;
      contribution = undefined;
    };

    pi.on('session_start', (_event, context) => {
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
    });
  }, PACKAGE_SOURCE);
}

/** The package's single standard Pi factory, including all optional typed host integrations. */
export async function voicePiExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(voicePlugin, { pi });
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
