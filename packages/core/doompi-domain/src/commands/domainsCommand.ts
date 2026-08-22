import type { DoomHarnessContext, HarnessState } from '@agimon-ai/doompi-config/types';
import { restoreHarnessStateSnapshot, snapshotHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import {
  type MinorModeReloadHandoffHandle,
  prepareMinorModeReloadHandoff,
  requireDoomTransitionCoordinator,
  type TransitionSource,
} from '@agimon-ai/doompi-extension-contracts/transition';
import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import { readDoomVoiceToolsService } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import {
  DOMAIN_COMMAND,
  domainItems,
  domainSummary,
  errorMessage,
  pickerTitle,
  splitDomains,
  switchedSummary,
  transitionError,
  unchangedSummary,
  voiceSwitchToken,
} from '../services/domainText.ts';
import type { DomainCompletion, DomainListing } from '../types/domains.ts';
import type { DomainSwitchHandoff, DomainSwitchHandoffIdentity, DomainSwitchHandoffStore } from '../types/handoff.ts';
import { DOMAIN_EVENT, type DomainTelemetry } from '../types/telemetry.ts';

const INFO = 'info';
const ERROR = 'error';

function failureDetail(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureDetail).join('; ');
  return error instanceof Error ? error.message : String(error);
}

function compensationDiagnostic(operation: string, error: unknown, compensationError: unknown): Error {
  return new Error(`${operation} compensation failed: ${failureDetail(compensationError)}`, { cause: error });
}

/** Everything the manifest reader gives the command, resolved lazily behind it. */
export interface DomainCatalogPort {
  list(ctx: ExtensionContext): Promise<DomainListing>;
  validate(ctx: ExtensionContext, values: readonly string[]): Promise<string[]>;
  describe(ctx: ExtensionContext): Promise<Record<string, string | undefined>>;
  completions(root: string, textBeforeCursor: string): Promise<DomainCompletion | undefined>;
}

export interface DomainsCommandDependencies {
  readonly cordisContext: () => Context;
  readonly catalog: DomainCatalogPort;
  readonly handoffs: DomainSwitchHandoffStore;
  readonly reloadHandoffs: VoiceReloadHandoffStore;
  readonly applyDomains: (domains: string[], state: DoomHarnessContext) => Promise<HarnessState>;
  readonly loadConfigJournal: () => Promise<typeof import('@agimon-ai/doompi-config/piContext')>;
  readonly loadPicker: () => Promise<typeof import('@agimon-ai/doompi-ui/components/matrixPicker')>;
}

/** Confirms the parked voice reload handoff, which the reload then acts on. */
function commitReloadHandoff(queued: DomainSwitchHandoff, reloadHandoffs: VoiceReloadHandoffStore): void {
  const committed = reloadHandoffs.commit(queued.reloadHandoffToken, {
    sessionId: queued.sessionId,
    hostGeneration: queued.hostGeneration,
  });
  if (!committed) throw new Error('The voice reload handoff is stale or was already consumed.');
}

async function pickDomains(
  ctx: ExtensionContext,
  dependencies: DomainsCommandDependencies,
): Promise<string[] | undefined> {
  const listing = await dependencies.catalog.list(ctx);
  const [{ MatrixPickerComponent }, descriptions] = await Promise.all([
    dependencies.loadPicker(),
    dependencies.catalog.describe(ctx),
  ]);
  // Domains compose, unlike a layer base, so this picker toggles with space and
  // confirms the whole set rather than replacing one value.
  return ctx.ui.custom<string[] | undefined>(
    (_tui, theme, keybindings, done) =>
      new MatrixPickerComponent(
        {
          title: pickerTitle(listing),
          items: domainItems(listing.available, descriptions),
          selected: [...listing.effective],
          multi: true,
        },
        theme,
        keybindings,
        done,
      ),
  );
}

export function registerDomainsCommand(
  pi: ExtensionAPI,
  telemetry: DomainTelemetry,
  dependencies: DomainsCommandDependencies,
): void {
  pi.registerCommand(DOMAIN_COMMAND, {
    description: 'Show the selected domains and pick a different set',
    handler: async (args, ctx) => {
      const cordis = dependencies.cordisContext();
      const state = requireDoomConfigContext(cordis).harness;
      let sessionIdentity: DomainSwitchHandoffIdentity | undefined;
      let queued: DomainSwitchHandoff | undefined;
      let minorModeReloadHandoff: MinorModeReloadHandoffHandle | undefined;
      let rollbackAppliedSwitch: (() => void) | undefined;
      let reloadRequested = false;
      try {
        const token = voiceSwitchToken(args);
        if (token) {
          const sessionId = ctx.sessionManager.getSessionId();
          const voiceSession = readDoomVoiceToolsService(cordis)?.readSession(sessionId);
          if (voiceSession) sessionIdentity = { sessionId, hostGeneration: voiceSession.hostGeneration };
          queued = sessionIdentity ? dependencies.handoffs.consume(token, sessionIdentity) : undefined;
          if (!queued) throw new Error('The voice domain switch token is stale or belongs to another session.');
        }

        let requested = queued ? [...queued.domains] : splitDomains(args);
        let pickerConfirmed = false;
        if (!queued && requested.length === 0 && ctx.mode === 'tui') {
          const chosen = await pickDomains(ctx, dependencies);
          if (chosen === undefined) return;
          requested = chosen;
          pickerConfirmed = true;
        }

        if (!queued && requested.length === 0 && !pickerConfirmed) {
          ctx.ui.notify(domainSummary(await dependencies.catalog.list(ctx)), INFO);
          return;
        }

        requested = await dependencies.catalog.validate(ctx, requested);
        const coordinator = requireDoomTransitionCoordinator(cordis);
        const source: TransitionSource = queued ? 'voice' : pickerConfirmed ? 'ui' : 'command';
        const result = await coordinator.execute(
          {
            sessionId: ctx.sessionManager.getSessionId(),
            hostGeneration: coordinator.hostGeneration,
            operationId: queued?.operationId ?? crypto.randomUUID(),
            source,
            target: { axis: 'domains', domains: requested },
          },
          async (_request, plan) => {
            await ctx.waitForIdle();
            minorModeReloadHandoff = prepareMinorModeReloadHandoff(
              cordis,
              ctx.sessionManager.getSessionId(),
              coordinator.hostGeneration,
              plan.operationId,
              plan.previous.minorModes,
            );
            const { persistHarnessSelection } = await dependencies.loadConfigJournal();
            const snapshot = snapshotHarnessState();
            const subagentEnvironment = {
              agentDirectories: process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS,
              skillDirectories: process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS,
            };
            const restoreCandidate = (compensateJournal: boolean): void => {
              const failures: unknown[] = [];
              try {
                restoreHarnessStateSnapshot(snapshot);
              } catch (error) {
                failures.push(error);
              }
              const restoreEnvironment = (key: string, value: string | undefined): void => {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              };
              restoreEnvironment('PI_SUBAGENT_EXTRA_AGENT_DIRS', subagentEnvironment.agentDirectories);
              restoreEnvironment('PI_SUBAGENT_EXTRA_SKILL_DIRS', subagentEnvironment.skillDirectories);
              if (compensateJournal) {
                try {
                  // Pi's selection journal is append-only. Once B has been
                  // recorded, restoring A means appending A as the newest
                  // authoritative selection rather than trying to erase B.
                  persistHarnessSelection(pi, snapshot.state);
                } catch (error) {
                  failures.push(error);
                }
              }
              if (failures.length > 0) {
                throw new AggregateError(failures, 'Could not restore the previous domain selection');
              }
            };
            let updated: HarnessState;
            let selectionJournaled = false;
            try {
              updated = await dependencies.applyDomains(requested, state);
              if (queued) commitReloadHandoff(queued, dependencies.reloadHandoffs);
              persistHarnessSelection(pi, updated);
              selectionJournaled = true;
              rollbackAppliedSwitch = () => restoreCandidate(true);
            } catch (error) {
              try {
                restoreCandidate(selectionJournaled);
              } catch (compensationError) {
                void telemetry.recordError(
                  DOMAIN_EVENT.domainsSwitchFailed,
                  compensationDiagnostic('Domain switch', error, compensationError),
                );
              }
              throw error;
            }

            void telemetry.recordEvent(DOMAIN_EVENT.domainsSwitched, {
              'harness.domains.previous': state.domains.join(','),
              'harness.domains': requested.join(','),
              'harness.transition.source': source,
              'harness.transition.disposition': plan.disposition,
              'harness.transition.operation_id': plan.operationId,
            });
            ctx.ui.notify(switchedSummary(requested), INFO);
            reloadRequested = true;
            // A structural switch is not live until Pi replaces this session.
            // Keeping it queued prevents the old coordinator from treating B
            // as committed if that terminal reload rejects and we restore A.
            return 'queued';
          },
        );
        if (result.outcome === 'unchanged') {
          ctx.ui.notify(unchangedSummary(requested), INFO);
          // A voice switch still has to reload: the follow-up command is the
          // only thing that consumes the handoff the tool already committed to.
          if (queued) {
            commitReloadHandoff(queued, dependencies.reloadHandoffs);
            await ctx.waitForIdle();
            reloadRequested = true;
          }
        } else if (result.outcome === 'rejected' || result.outcome === 'stale') {
          throw transitionError(result);
        }
      } catch (error) {
        reloadRequested = false;
        if (rollbackAppliedSwitch) {
          try {
            rollbackAppliedSwitch();
          } catch (compensationError) {
            void telemetry.recordError(
              DOMAIN_EVENT.domainsSwitchFailed,
              compensationDiagnostic('Domain switch', error, compensationError),
            );
          }
          rollbackAppliedSwitch = undefined;
        }
        minorModeReloadHandoff?.discard();
        minorModeReloadHandoff = undefined;
        if (queued && sessionIdentity) {
          dependencies.handoffs.discard(queued.token, sessionIdentity);
          dependencies.reloadHandoffs.discard(queued.reloadHandoffToken, {
            sessionId: queued.sessionId,
            hostGeneration: queued.hostGeneration,
          });
        }
        void telemetry.recordError(DOMAIN_EVENT.domainsSwitchFailed, error);
        ctx.ui.notify(errorMessage(error), ERROR);
      }

      if (reloadRequested) {
        try {
          // Reload must be the handler's terminal action: Pi invalidates this
          // command context as soon as the replacement session is active.
          await ctx.reload();
        } catch (error) {
          if (rollbackAppliedSwitch) {
            try {
              rollbackAppliedSwitch();
            } catch (compensationError) {
              void telemetry.recordError(
                DOMAIN_EVENT.domainsSwitchFailed,
                compensationDiagnostic('Domain reload', error, compensationError),
              );
            }
            rollbackAppliedSwitch = undefined;
          }
          minorModeReloadHandoff?.discard();
          if (queued && sessionIdentity) {
            dependencies.handoffs.discard(queued.token, sessionIdentity);
            dependencies.reloadHandoffs.discard(queued.reloadHandoffToken, {
              sessionId: queued.sessionId,
              hostGeneration: queued.hostGeneration,
            });
          }
          throw error;
        }
      }
    },
  });
}
