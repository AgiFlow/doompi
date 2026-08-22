import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
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
} from '@agimon-ai/doompi-extension-contracts/delegation';
import { DOOM_FABLE_PLAN_SERVICE, type DoomFablePlanService } from '@agimon-ai/doompi-extension-contracts/fable-plan';
import {
  DOOM_SUBAGENT_POLICY_SERVICE,
  type DoomSubagentPolicyService,
} from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import type { Context } from '@deepseek-ai/cordis';
import type { DelegationBridge, DelegationSessionContext } from './extensions/delegationBridge';
import type { FablePlanBridge } from './extensions/fablePlanBridge';
import type { SubagentCapabilityPolicyStore } from '../../schemas/team/capabilityCeiling';
import { createBackgroundWorkService } from '../../services/backgroundWorkService';
import { createSubagentPolicyService } from '../../services/subagentPolicyService';

export interface TeamCollaborationPluginConfig {
  readonly session: DelegationSessionContext & { readonly cwd: string };
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
    cwd: config.session.cwd,
  });

  ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
  ctx.provide(DOOM_SUBAGENT_POLICY_SERVICE, subagentPolicy);
  ctx.provide(DOOM_DELEGATION_SERVICE, delegation);
  ctx.provide(DOOM_FABLE_PLAN_SERVICE, fablePlan);

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
