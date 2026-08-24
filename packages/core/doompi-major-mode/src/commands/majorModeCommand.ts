import { restoreHarnessStateSnapshot, snapshotHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import {
  appendDoomConfigTransition,
  replaceDoomConfigContext,
  requireDoomConfigContext,
  supersedeDoomConfigTransition,
} from '@agimon-ai/doompi-config/piContext';
import type { DoomConfigPendingSelection } from '@agimon-ai/doompi-config/types';
import { alreadyComposed } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  type DoomTransitionResult,
  type MinorModeReloadHandoffHandle,
  prepareMinorModeReloadHandoff,
  requireDoomTransitionCoordinator,
} from '@agimon-ai/doompi-extension-contracts/transition';
import { readDoomVoiceToolsService } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type {
  VoiceReloadHandoff,
  VoiceReloadHandoffIdentity,
  VoiceReloadHandoffStore,
} from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import {
  applySummary,
  errorMessage,
  MAJOR_MODE_COMMAND,
  majorModeItems,
  majorModeOptionLabel,
  majorModeSummary,
  optionName,
  voiceSwitchToken,
} from '../services/majorModeText.ts';
import { colorStatus, STATUS_KEY } from '../services/statusLine.ts';
import { MAJOR_MODE_EVENT, type MajorModeTelemetry } from '../types/telemetry.ts';
import { bindPendingSelection, clearPendingSelection, selectionFromSnapshot } from '../services/pendingSelection.ts';
import { MAJOR_MODE_SWITCH_HANDOFF_KIND, type MajorModeView } from '../types/majorMode.ts';

function transitionError(result: DoomTransitionResult): Error {
  return new Error(`Major-mode transition was ${result.outcome}: ${result.diagnostics.join(', ')}`);
}

export interface MajorModeCommandDependencies {
  readonly cordisContext: () => Context;
  readonly currentView: (ctx: ExtensionContext) => Promise<MajorModeView>;
  readonly reloadHandoffs: VoiceReloadHandoffStore;
  readonly loadPicker: () => Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')>;
  readonly loadSelectionSwitch: () => Promise<typeof import('@agimon-ai/doompi-config/selectionSwitch')>;
  readonly loadConfigJournal: () => Promise<typeof import('@agimon-ai/doompi-config/piContext')>;
  readonly resolveLayers: (config: MajorModeView['config'], majorMode: string) => string[];
  /** Whether an owning process supervisor listens for relaunch requests. */
  readonly supervisedRelaunchAvailable: () => boolean;
  /** Asks the supervisor to relaunch with the picked mode; call only at idle. */
  readonly requestSupervisedRelaunch: (majorMode: string, operationId: string) => boolean;
}

export function registerMajorModeCommand(
  pi: ExtensionAPI,
  telemetry: MajorModeTelemetry,
  dependencies: MajorModeCommandDependencies,
): void {
  pi.registerCommand(MAJOR_MODE_COMMAND, {
    description: 'Pick a named major mode',
    handler: async (args, ctx) => {
      let token: string | undefined;
      try {
        token = voiceSwitchToken(args);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
        return;
      }
      if (args.trim() && !token) {
        ctx.ui.notify(`Usage: /${MAJOR_MODE_COMMAND}`, 'warning');
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const cordis = dependencies.cordisContext();
      let sessionIdentity: VoiceReloadHandoffIdentity | undefined;
      let handoff: VoiceReloadHandoff | undefined;
      let minorModeReloadHandoff: MinorModeReloadHandoffHandle | undefined;
      let reloadRequested = false;
      let performRelaunch: (() => boolean) | undefined;
      try {
        const { config, majorMode, domains, profile } = await dependencies.currentView(ctx);
        const names = Object.keys(config.majorMode);
        let picked: string | undefined;

        if (token) {
          const voiceSession = readDoomVoiceToolsService(cordis)?.readSession(sessionId);
          if (voiceSession) sessionIdentity = { sessionId, hostGeneration: voiceSession.hostGeneration };
          handoff = sessionIdentity ? dependencies.reloadHandoffs.accept(token, sessionIdentity) : undefined;
          if (handoff?.kind !== MAJOR_MODE_SWITCH_HANDOFF_KIND || !handoff.majorMode) {
            throw new Error('The voice major-mode switch token is stale or belongs to another session.');
          }
          picked = handoff.majorMode;
        } else {
          const title = `Major mode (current: ${majorMode})`;
          const chosen =
            ctx.mode === 'tui'
              ? await dependencies
                  .loadPicker()
                  .then(({ MatrixPickerComponent }) =>
                    ctx.ui.custom<string[] | undefined>(
                      (_tui, theme, keybindings, done) =>
                        new MatrixPickerComponent(
                          { title, items: majorModeItems(config, names), selected: [majorMode], multi: false },
                          theme,
                          keybindings,
                          done,
                        ),
                    ),
                  )
              : [
                  optionName(
                    (await ctx.ui.select(
                      title,
                      names.map((name) => majorModeOptionLabel(name, config.majorMode[name]?.layers ?? [], majorMode)),
                    )) ?? '',
                  ),
                ];
          picked = chosen?.[0];
        }
        if (!picked) return;

        const composed = alreadyComposed();
        if (picked === majorMode) {
          if (token && sessionIdentity) dependencies.reloadHandoffs.discard(token, sessionIdentity);
          clearPendingSelection(pi, dependencies.cordisContext());
          ctx.ui.notify(
            majorModeSummary(picked, dependencies.resolveLayers(config, picked), majorMode, composed),
            'info',
          );
          return;
        }

        const coordinator = requireDoomTransitionCoordinator(cordis);
        const result = await coordinator.execute(
          {
            sessionId: ctx.sessionManager.getSessionId(),
            hostGeneration: coordinator.hostGeneration,
            operationId: handoff?.operationId ?? crypto.randomUUID(),
            source: handoff ? 'voice' : 'command',
            target: { axis: 'major-mode', majorMode: picked },
          },
          async (_request, plan) => {
            const selected = [...plan.candidate.layers];
            const stale = plan.externalRelaunchRequired;
            const currentContextAtExecution = requireDoomConfigContext(cordis);
            const harness = currentContextAtExecution.harness;
            if (plan.strategy === 'process-relaunch') {
              const pendingSelection: DoomConfigPendingSelection = {
                version: 1,
                operationId: plan.operationId,
                active: selectionFromSnapshot(plan.previous),
                target: selectionFromSnapshot(plan.candidate),
                strategy: plan.strategy,
                phase: 'pending',
              };
              const existingPending = requireDoomConfigContext(cordis).pendingSelection;
              if (existingPending) supersedeDoomConfigTransition(pi, existingPending);
              appendDoomConfigTransition(pi, pendingSelection);
              replaceDoomConfigContext(
                cordis,
                bindPendingSelection(requireDoomConfigContext(cordis), pendingSelection),
              );
              void telemetry.recordEvent(MAJOR_MODE_EVENT.majorModeSwitched, {
                'harness.major_mode.previous': harness.majorMode,
                'harness.major_mode': picked,
                'harness.layers': selected.join(','),
                'harness.major_mode.stale': true,
                'harness.transition.disposition': plan.disposition,
                'harness.transition.operation_id': plan.operationId,
              });
              ctx.ui.setStatus(
                STATUS_KEY,
                colorStatus(ctx.ui.theme, harness.majorMode, harness.domains, harness.profile, true),
              );
              if (dependencies.supervisedRelaunchAvailable()) {
                const target = picked;
                performRelaunch = () => dependencies.requestSupervisedRelaunch(target, plan.operationId);
              }
              ctx.ui.notify(
                applySummary(picked, selected, true, composed, plan.strategy, performRelaunch !== undefined),
                'info',
              );
              return 'queued';
            }
            const [{ applyMajorMode }, { persistHarnessSelection }] = await Promise.all([
              dependencies.loadSelectionSwitch(),
              dependencies.loadConfigJournal(),
            ]);
            const transition: DoomConfigPendingSelection = {
              version: 1,
              operationId: plan.operationId,
              active: selectionFromSnapshot(plan.previous),
              target: selectionFromSnapshot(plan.candidate),
              strategy: plan.strategy ?? 'pi-reload',
              phase: 'pending',
            };
            const activeConfig = loadMajorModesConfig(harness.root ?? ctx.cwd);
            const snapshot = snapshotHarnessState();
            const existingPending = currentContextAtExecution.pendingSelection;
            minorModeReloadHandoff = prepareMinorModeReloadHandoff(
              cordis,
              ctx.sessionManager.getSessionId(),
              coordinator.hostGeneration,
              plan.operationId,
              plan.previous.minorModes,
            );
            try {
              if (existingPending) supersedeDoomConfigTransition(pi, existingPending);
              appendDoomConfigTransition(pi, transition);
              const updated = applyMajorMode(
                activeConfig,
                picked,
                harness,
                plan.candidate.compositionFingerprint,
                plan.candidate.childActivation,
              );
              persistHarnessSelection(pi, updated);
            } catch (error) {
              minorModeReloadHandoff?.discard();
              minorModeReloadHandoff = undefined;
              try {
                restoreHarnessStateSnapshot(snapshot);
              } catch (compensationError) {
                const detail =
                  compensationError instanceof Error ? compensationError.message : String(compensationError);
                throw new Error(`Transition failed and compensation failed: ${detail}`, { cause: error });
              }
              appendDoomConfigTransition(pi, { ...transition, phase: 'aborted' });
              if (existingPending) appendDoomConfigTransition(pi, existingPending);
              throw error;
            }

            void telemetry.recordEvent(MAJOR_MODE_EVENT.majorModeSwitched, {
              'harness.major_mode.previous': majorMode,
              'harness.major_mode': picked,
              'harness.layers': selected.join(','),
              'harness.major_mode.stale': stale,
              'harness.transition.disposition': plan.disposition,
              'harness.transition.operation_id': plan.operationId,
            });
            ctx.ui.setStatus(STATUS_KEY, colorStatus(ctx.ui.theme, picked, domains, profile, false));
            ctx.ui.notify(applySummary(picked, selected, false, composed, plan.strategy), 'info');
            // Reload must be the command handler's terminal action. Pi invalidates
            // this command context as soon as the replacement session is active.
            reloadRequested = true;
            return 'applied';
          },
        );
        if (result.outcome === 'rejected' || result.outcome === 'stale') throw transitionError(result);
      } catch (error) {
        reloadRequested = false;
        performRelaunch = undefined;
        minorModeReloadHandoff?.discard();
        minorModeReloadHandoff = undefined;
        if (!token) throw error;
        if (sessionIdentity) dependencies.reloadHandoffs.discard(token, sessionIdentity);
        ctx.ui.notify(errorMessage(error), 'error');
      }

      if (reloadRequested) {
        try {
          await ctx.waitForIdle();
          // The replacement session acknowledges the pending journal after its
          // bootstrap harness is active. Do not touch ctx after this await.
          await ctx.reload();
        } catch (error) {
          minorModeReloadHandoff?.discard();
          throw error;
        }
      }
      if (performRelaunch) {
        // Written only at idle: the supervisor ends this agent's input for a
        // graceful exit the moment the file appears, then respawns it with the
        // pending major mode; the replacement resumes the session and
        // acknowledges the journal.
        await ctx.waitForIdle();
        if (performRelaunch()) ctx.shutdown();
      }
    },
  });
}
