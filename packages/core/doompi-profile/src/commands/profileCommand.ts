import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import {
  type MinorModeReloadHandoffHandle,
  prepareMinorModeReloadHandoff,
  requireDoomTransitionCoordinator,
} from '@agimon-ai/doompi-extension-contracts/transition';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import { profileItems, profileSummary, profileTitle } from '../services/profileText.ts';
import { PROFILE_EVENT, type ProfileTelemetry } from '../types/telemetry.ts';

const WARNING = 'warning';
const INFO = 'info';
const PROFILE_CONFIG_PATH = '.doom/profiles.yaml';

/**
 * The picker and everything behind it load on first use.
 *
 * Every session registers this command, but almost none of them run it, so the
 * profile catalogue, the TUI component and the switch stay off the startup path.
 */
function lazyModules() {
  let harnessStore: Promise<typeof import('@agimon-ai/doompi-config/harnessStore')> | undefined;
  let journal: Promise<typeof import('@agimon-ai/doompi-config/piContext')> | undefined;
  let picker: Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')> | undefined;
  let profiles: Promise<typeof import('@agimon-ai/doompi-config/profiles')> | undefined;
  let selection: Promise<typeof import('@agimon-ai/doompi-config/selectionSwitch')> | undefined;
  return {
    harnessStore: () => (harnessStore ??= import('@agimon-ai/doompi-config/harnessStore')),
    journal: () => (journal ??= import('@agimon-ai/doompi-config/piContext')),
    picker: () => (picker ??= import('@agimon-ai/doompi-ui/components/matrixPicker')),
    profiles: () => (profiles ??= import('@agimon-ai/doompi-config/profiles')),
    selection: () => (selection ??= import('@agimon-ai/doompi-config/selectionSwitch')),
  };
}

async function pickProfile(
  ctx: ExtensionContext,
  profiles: AgentProfile[],
  current: string | undefined,
  loadPicker: () => Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')>,
): Promise<string | undefined> {
  const title = profileTitle(current);
  if (ctx.mode !== 'tui') {
    return ctx.ui.select(
      title,
      profiles.map((profile) => profile.name),
    );
  }
  const { MatrixPickerComponent } = await loadPicker();
  const chosen = await ctx.ui.custom<string[] | undefined>(
    (_tui, theme, keybindings, done) =>
      new MatrixPickerComponent(
        { title, items: profileItems(profiles), selected: current ? [current] : [], multi: false },
        theme,
        keybindings,
        done,
      ),
  );
  return chosen?.[0];
}

export function registerProfileCommand(
  pi: ExtensionAPI,
  telemetry: ProfileTelemetry,
  cordisContext: () => Context,
): void {
  const load = lazyModules();

  pi.registerCommand('profile', {
    description: 'Show profiles and load a different persona and environment',
    handler: async (_args, ctx) => {
      const cordis = cordisContext();
      const state = requireDoomConfigContext(cordis).harness;
      const [{ requireHarnessRoot }, { loadProfiles }] = await Promise.all([load.harnessStore(), load.profiles()]);
      const root = requireHarnessRoot(state);
      const current = state.profile;
      let profiles: AgentProfile[];
      try {
        profiles = loadProfiles(root);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        void telemetry.recordError(PROFILE_EVENT.profileLoadFailed, error);
        ctx.ui.notify(`Could not load ${PROFILE_CONFIG_PATH}: ${reason}`, WARNING);
        return;
      }

      if (profiles.length === 0) {
        ctx.ui.notify(`No profiles found in ${PROFILE_CONFIG_PATH}.`, WARNING);
        return;
      }

      const picked = await pickProfile(ctx, profiles, current, load.picker);
      const profile = profiles.find((candidate) => candidate.name === picked);
      if (!profile) return;
      if (profile.name === current) {
        ctx.ui.notify(profileSummary(profile), INFO);
        return;
      }

      const coordinator = requireDoomTransitionCoordinator(cordis);
      let minorModeReloadHandoff: MinorModeReloadHandoffHandle | undefined;
      const result = await coordinator.execute(
        {
          sessionId: ctx.sessionManager.getSessionId(),
          hostGeneration: coordinator.hostGeneration,
          operationId: crypto.randomUUID(),
          source: ctx.mode === 'tui' ? 'ui' : 'command',
          target: { axis: 'profile', profile: profile.name },
        },
        async (_request, plan) => {
          minorModeReloadHandoff = prepareMinorModeReloadHandoff(
            cordis,
            ctx.sessionManager.getSessionId(),
            coordinator.hostGeneration,
            plan.operationId,
            plan.previous.minorModes,
          );
          try {
            const { applyProfile } = await load.selection();
            ctx.ui.notify(await applyProfile(profile, state), INFO);
            const { persistHarnessSelection } = await load.journal();
            persistHarnessSelection(pi, { ...state, profile: profile.name });
            void telemetry.recordEvent(PROFILE_EVENT.profileApplied, {
              'harness.profile': profile.name,
              ...(current ? { 'harness.profile.previous': current } : {}),
              'harness.transition.disposition': plan.disposition,
              'harness.transition.operation_id': plan.operationId,
            });
            return 'applied';
          } catch (error) {
            minorModeReloadHandoff?.discard();
            minorModeReloadHandoff = undefined;
            throw error;
          }
        },
      );
      if (result.outcome === 'rejected' || result.outcome === 'stale') {
        minorModeReloadHandoff?.discard();
        ctx.ui.notify(`Profile transition was ${result.outcome}: ${result.diagnostics.join(', ')}`, WARNING);
        return;
      }
      if (result.outcome !== 'applied') {
        minorModeReloadHandoff?.discard();
        return;
      }

      try {
        await ctx.waitForIdle();
        // Reload replaces the session and invalidates this command context.
        // Keep it as the handler's final action.
        await ctx.reload();
      } catch (error) {
        minorModeReloadHandoff?.discard();
        throw error;
      }
    },
  });
}
