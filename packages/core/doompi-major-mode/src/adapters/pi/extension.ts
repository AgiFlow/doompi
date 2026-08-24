import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  DOOM_VOICE_TOOLS_SERVICE,
  requireDoomVoiceToolsService,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerMajorModeCommand } from '../../commands/majorModeCommand.ts';
import { requestSupervisedRelaunch, supervisedRelaunchAvailable } from './relaunchRequest.ts';
import { colorStatus, STATUS_KEY } from '../../services/statusLine.ts';
import { MAJOR_MODE_SOURCE, type MajorModeView } from '../../types/majorMode.ts';
import { MAJOR_MODE_EVENT, type MajorModeTelemetry } from '../../types/telemetry.ts';
import { createMajorModeTelemetry } from '../telemetry/logSinkTelemetry.ts';
import { registerMajorModeVoiceCapability } from './voiceTool.ts';

/**
 * Everything the axis needs beyond the session, loaded on first use.
 *
 * Every session registers /mode, but most never run it, so the picker, the
 * switch and the journal stay off the startup path.
 */
function lazyModules() {
  let config: Promise<typeof import('@agimon-ai/doompi-config/majorModes')> | undefined;
  let journal: Promise<typeof import('@agimon-ai/doompi-config/piContext')> | undefined;
  let picker: Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')> | undefined;
  let selection: Promise<typeof import('@agimon-ai/doompi-config/selectionSwitch')> | undefined;
  return {
    config: () => (config ??= import('@agimon-ai/doompi-config/majorModes')),
    journal: () => (journal ??= import('@agimon-ai/doompi-config/piContext')),
    picker: () => (picker ??= import('@agimon-ai/doompi-ui/components/matrixPicker')),
    selection: () => (selection ??= import('@agimon-ai/doompi-config/selectionSwitch')),
  };
}

interface MajorModePluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: MajorModeTelemetry;
}

function majorModePlugin(cordis: Context, { pi, telemetry }: MajorModePluginConfig): void {
  const load = lazyModules();
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: MAJOR_MODE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-major-mode',
          description:
            "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
        },
      ],
    });
    return () => contribution.dispose();
  });

  let activeContext: Context | undefined;
  const runtimeInjection = cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  const requireRuntimeContext = (): Context => {
    if (!activeContext) throw new Error('Doom major-mode runtime is waiting for the session config service.');
    return activeContext;
  };
  const currentView = async (_ctx: ExtensionContext): Promise<MajorModeView> => {
    const state = requireDoomConfigContext(requireRuntimeContext()).harness;
    const { loadMajorModesConfig } = await load.config();
    return {
      config: loadMajorModesConfig(requireHarnessRoot(state)),
      majorMode: state.majorMode,
      domains: state.domains,
      profile: state.profile,
    };
  };
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });
  cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE, DOOM_VOICE_TOOLS_SERVICE], (voiceContext) =>
    registerMajorModeVoiceCapability(
      requireDoomVoiceToolsService(voiceContext),
      pi,
      currentView,
      reloadHandoffs,
      () => voiceContext,
    ),
  );

  cordis.effect(function* () {
    registerMajorModeCommand(pi, telemetry, {
      cordisContext: requireRuntimeContext,
      currentView,
      reloadHandoffs,
      loadPicker: load.picker,
      loadSelectionSwitch: load.selection,
      loadConfigJournal: load.journal,
      resolveLayers: (config, majorMode) => [...(config.majorMode[majorMode]?.layers ?? [])],
      supervisedRelaunchAvailable,
      requestSupervisedRelaunch,
    });
    pi.on('session_start', async (_event, ctx) => {
      await runtimeInjection.await();
      try {
        const { majorMode, domains, profile } = requireDoomConfigContext(requireRuntimeContext()).harness;
        ctx.ui.setStatus(STATUS_KEY, colorStatus(ctx.ui.theme, majorMode, domains, profile, false));
      } catch (error) {
        void telemetry.recordError(MAJOR_MODE_EVENT.majorModeUnavailable, error);
        ctx.ui.setStatus(
          STATUS_KEY,
          `major mode unavailable (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    });
    yield () => undefined;
  }, MAJOR_MODE_SOURCE);
}

/** The package's single standard Pi factory. */
export async function majorModeExtension(
  pi: ExtensionAPI,
  telemetry: MajorModeTelemetry = createMajorModeTelemetry(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, MAJOR_MODE_SOURCE);
  const fiber = connection.root.plugin(majorModePlugin, { pi, telemetry });
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

export default majorModeExtension;
