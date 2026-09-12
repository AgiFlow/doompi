import {
  DOOM_CORDIS_SESSION_SERVICE,
  requireDoomCordisSession,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-core/cordis-host';
import { DOOM_BACKGROUND_WORK_SERVICE, type DoomBackgroundWorkService } from '@agimon-ai/doompi-core/background-work';
import {
  type DelegationCancel,
  type DelegationRequest,
  type DelegationResult,
  type DelegationStarted,
  type DelegationUpdate,
  DOOM_DELEGATION_CANCELLED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_REQUESTED_EVENT,
  DOOM_DELEGATION_SERVICE,
  DOOM_DELEGATION_STARTED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  type DoomDelegationService,
} from '../../schemas/delegationApi';
import { DOOM_FABLE_PLAN_SERVICE, type DoomFablePlanService } from '../../schemas/fablePlanApi';
import { DOOM_SUBAGENT_POLICY_SERVICE, type DoomSubagentPolicyService } from '../../schemas/subagentPolicy';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { AsyncJobTracker } from '../asyncJobTracker';
import type { DelegationBridge, DelegationSessionContext } from '../delegationBridge';
import { registerDirectRunBackgroundWork } from '../directRunBackgroundWork';
import type { FablePlanBridge } from '../fablePlanBridge';
import type { SubagentCapabilityPolicyStore } from '../../schemas/team/capabilityCeiling';
import { createBackgroundWorkService } from '../backgroundWorkService';
import { createSubagentPolicyService } from '../subagentPolicyService';

export interface TeamCollaborationPluginConfig {
  readonly session: DelegationSessionContext & {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  };
  readonly directRunTracker: AsyncJobTracker;
  readonly delegation: DelegationBridge;
  readonly fablePlan: FablePlanBridge;
  readonly policies: SubagentCapabilityPolicyStore;
  readonly observeDelegation?: (observation: TeamDelegationObservation) => void;
}

export type TeamDelegationObservation =
  | { readonly kind: 'requested'; readonly event: DelegationRequest }
  | { readonly kind: 'started'; readonly event: DelegationStarted }
  | { readonly kind: 'updated'; readonly event: DelegationUpdate }
  | { readonly kind: 'finished'; readonly event: DelegationResult }
  | { readonly kind: 'cancelled'; readonly event: DelegationCancel };

/** Mount every Team-owned collaboration capability in one session fiber. */
export function teamCollaborationPlugin(ctx: Context, config: TeamCollaborationPluginConfig): void {
  const backgroundWork: DoomBackgroundWorkService = createBackgroundWorkService(ctx);
  const subagentPolicy: DoomSubagentPolicyService = createSubagentPolicyService(config.policies);
  const delegation: DoomDelegationService = config.delegation.createService(ctx, config.session);
  const fablePlan: DoomFablePlanService = config.fablePlan.createService({
    sessionId: config.session.sessionId,
    scope: config.session.sessionScope,
    cwd: config.session.cwd,
    environment: config.session.environment,
  });

  ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
  ctx.provide(DOOM_SUBAGENT_POLICY_SERVICE, subagentPolicy);
  ctx.provide(DOOM_DELEGATION_SERVICE, delegation);
  ctx.provide(DOOM_FABLE_PLAN_SERVICE, fablePlan);
  registerDirectRunBackgroundWork(ctx, backgroundWork, config.session.sessionId, config.directRunTracker);

  if (config.observeDelegation) {
    ctx.on(DOOM_DELEGATION_REQUESTED_EVENT, (event) => config.observeDelegation?.({ kind: 'requested', event }));
    ctx.on(DOOM_DELEGATION_STARTED_EVENT, (event) => config.observeDelegation?.({ kind: 'started', event }));
    ctx.on(DOOM_DELEGATION_UPDATED_EVENT, (event) => config.observeDelegation?.({ kind: 'updated', event }));
    ctx.on(DOOM_DELEGATION_FINISHED_EVENT, (event) => config.observeDelegation?.({ kind: 'finished', event }));
    ctx.on(DOOM_DELEGATION_CANCELLED_EVENT, (event) => config.observeDelegation?.({ kind: 'cancelled', event }));
  }

  ctx.effect(
    () => () => {
      config.delegation.abandonAll();
      config.fablePlan.abandonAll();
      config.policies.clear();
    },
    '@agimon-ai/doompi-team/collaboration',
  );
}

export interface TeamCollaborationMount {
  plugin(this: void, context: Context): void;
  mount(config: TeamCollaborationPluginConfig, sessionManager: object): Promise<Fiber>;
  dispose(): Promise<void>;
}

/** Owns replacement collaboration fibers in the current injected session, or the standalone mount. */
export function createTeamCollaborationMount(): TeamCollaborationMount {
  let owner: Context | undefined;
  let sessionParent: { context: Context; service: DoomCordisSessionService } | undefined;
  let mountedParent: Context | undefined;
  let revision = 0;
  let mounted: Fiber | undefined;
  let disposed = false;
  const retire = async (): Promise<void> => {
    const previous = mounted;
    mounted = undefined;
    mountedParent = undefined;
    await previous?.dispose();
  };
  const dispose = async (): Promise<void> => {
    revision += 1;
    await retire();
  };
  return {
    plugin(context) {
      owner = context;
      context.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
        const service = requireDoomCordisSession(sessionContext);
        sessionParent = { context: sessionContext, service };
        return async () => {
          if (sessionParent?.context !== sessionContext) return;
          sessionParent = undefined;
          if (mountedParent === sessionContext) await dispose();
        };
      });
      context.effect(() => async () => {
        disposed = true;
        owner = undefined;
        await dispose();
      });
    },
    async mount(config, sessionManager) {
      const ownRevision = ++revision;
      await retire();
      if (ownRevision !== revision) throw new Error('Team collaboration mount was superseded.');
      const parent = sessionParent?.service.context.sessionManager === sessionManager ? sessionParent.context : owner;
      if (!parent || disposed) throw new Error('Team collaboration service is not mounted.');
      const fiber = parent.plugin(teamCollaborationPlugin, config);
      mounted = fiber;
      mountedParent = parent;
      return fiber;
    },
    dispose,
  };
}
