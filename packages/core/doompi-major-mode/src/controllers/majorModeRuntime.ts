import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-core/transition';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-core/voice-reload-handoff';
import { DOOM_VOICE_TOOLS_SERVICE, requireDoomVoiceToolsService } from '@agimon-ai/doompi-core/voice-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { colorStatus, STATUS_KEY } from '../services/statusLine';
import { type MajorModeView } from '../types/majorMode';
import { MAJOR_MODE_EVENT, type MajorModeTelemetry } from '../types/telemetry';
import { createMajorModeCommand } from './majorModeCommand';
import { requestSupervisedRelaunch, supervisedRelaunchAvailable } from './relaunchRequest';
import { registerMajorModeVoiceCapability } from './voiceTool';

/**
 * Everything the axis needs beyond the session, loaded on first use.
 *
 * Every session registers /mode, but most never run it, so the picker, the
 * switch and the journal stay off the startup path.
 */
function lazyModules() {
  let config: Promise<typeof import('@agimon-ai/doompi-config/majorModes')> | undefined;
  let journal: Promise<typeof import('@agimon-ai/doompi-config/piContext')> | undefined;
  let picker: Promise<typeof import('@agimon-ai/doompi-ui/matrix-picker')> | undefined;
  let selection: Promise<typeof import('@agimon-ai/doompi-config/selectionSwitch')> | undefined;
  return {
    config: () => (config ??= import('@agimon-ai/doompi-config/majorModes')),
    journal: () => (journal ??= import('@agimon-ai/doompi-config/piContext')),
    picker: () => (picker ??= import('@agimon-ai/doompi-ui/matrix-picker')),
    selection: () => (selection ??= import('@agimon-ai/doompi-config/selectionSwitch')),
  };
}

interface MajorModePluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: MajorModeTelemetry;
}

export function createMajorModeRuntime({
  pi,
  telemetry,
}: MajorModePluginConfig): PiPluginContributions<MajorModeTelemetry> {
  const load = lazyModules();

  let activeContext: Context | undefined;
  let runtimeInjection: ReturnType<Context['inject']> | undefined;
  const bindRuntime = (cordis: Context) => {
    runtimeInjection = cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE], (context) => {
      activeContext = context;
      return () => {
        if (activeContext === context) activeContext = undefined;
      };
    });
  };
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
  const bindVoice = (cordis: Context) => {
    cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE, DOOM_VOICE_TOOLS_SERVICE], (voiceContext) =>
      registerMajorModeVoiceCapability(
        requireDoomVoiceToolsService(voiceContext),
        pi,
        currentView,
        reloadHandoffs,
        () => voiceContext,
      ),
    );
  };
  return {
    services: [bindRuntime, bindVoice],
    commands: [
      createMajorModeCommand(pi, telemetry, {
        cordisContext: requireRuntimeContext,
        currentView,
        reloadHandoffs,
        loadPicker: load.picker,
        loadSelectionSwitch: load.selection,
        loadConfigJournal: load.journal,
        resolveLayers: (config, majorMode) => [...(config.majorMode[majorMode]?.layers ?? [])],
        supervisedRelaunchAvailable,
        requestSupervisedRelaunch,
      }),
    ],
    events: {
      session_start: async (_event, ctx) => {
        await runtimeInjection?.await();
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
      },
    },
  };
}
