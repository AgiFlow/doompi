import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-core/transition';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-voice/voice-reload-handoff';
import { DOOM_VOICE_TOOLS_SERVICE, requireDoomVoiceToolsService } from '@agimon-ai/doompi-voice/voice-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createProfileCommand } from './profileCommand';
import { PROFILE_STATUS_KEY, profileStatus } from '../services/profileText';
import { publishProfileIdentity } from './identityEntry';
import { registerProfileVoiceCapability, type ProfileVoiceView } from './voiceTool';
import { PROFILE_EVENT, type ProfileTelemetry } from '../types/telemetry';

/**
 * Whether the session has any profiles to offer. Reading the catalogue is
 * the one startup cost the axis needs; a broken catalogue reports true so
 * the axis stays on the bar and /profile can explain the failure.
 */
async function profileCatalogueExists(
  state: Pick<HarnessState, 'root'>,
  telemetry: ProfileTelemetry,
): Promise<boolean> {
  try {
    const [{ requireHarnessRoot }, { loadProfiles }] = await Promise.all([
      import('@agimon-ai/doompi-config/harnessStore'),
      import('@agimon-ai/doompi-config/profiles'),
    ]);
    return loadProfiles(requireHarnessRoot(state)).length > 0;
  } catch (error) {
    void telemetry.recordError(PROFILE_EVENT.profileLoadFailed, error);
    return true;
  }
}

interface ProfilePluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: ProfileTelemetry;
}

export function createProfileRuntime(config: ProfilePluginConfig): PiPluginContributions<ProfileTelemetry> {
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
    if (!activeContext) throw new Error('Doom profile runtime is waiting for the session config service.');
    return activeContext;
  };

  // The store standing between the voice capability and the command handler:
  // the tool cannot reload the session itself, so it parks the chosen profile
  // here and hands the command an opaque token.
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });

  const currentView = async (): Promise<ProfileVoiceView> => {
    const state = requireDoomConfigContext(requireRuntimeContext()).harness;
    const [{ requireHarnessRoot }, { loadProfiles }] = await Promise.all([
      import('@agimon-ai/doompi-config/harnessStore'),
      import('@agimon-ai/doompi-config/profiles'),
    ]);
    return {
      ...(state.profile === undefined ? {} : { current: state.profile }),
      profiles: loadProfiles(requireHarnessRoot(state)),
    };
  };

  // A separate injection, so the command keeps working in a session that has no
  // autonomous voice and the two-service inject above stays exactly as it was.
  const bindVoice = (cordis: Context) => {
    cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE, DOOM_VOICE_TOOLS_SERVICE], (voiceContext) =>
      registerProfileVoiceCapability(
        requireDoomVoiceToolsService(voiceContext),
        config.pi,
        currentView,
        reloadHandoffs,
        () => voiceContext,
      ),
    );
  };
  let publishedIdentity: string | undefined;
  return {
    services: [bindRuntime, bindVoice],
    commands: [createProfileCommand(config.pi, config.telemetry, requireRuntimeContext, reloadHandoffs)],
    events: {
      session_start: async (_event, ctx) => {
        await runtimeInjection?.await();
        const state = requireDoomConfigContext(requireRuntimeContext()).harness;
        const status = profileStatus(state.profile, await profileCatalogueExists(state, config.telemetry));
        if (status !== undefined) ctx.ui.setStatus(PROFILE_STATUS_KEY, status);
        publishedIdentity = publishProfileIdentity(config.pi, state.profile, state.profileIdentity, publishedIdentity);
      },
    },
  };
}
