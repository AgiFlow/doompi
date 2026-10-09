import {
  BACKGROUND_WORK_HOLDING_PROVIDERS,
  holdsSettledSession,
  type DoomBackgroundWorkSnapshot,
} from '@agimon-ai/doompi-core/backgroundWork';
import {
  gateStepDecision,
  WORKFLOW_DECISION_FILE_ENV,
  WORKFLOW_DECISION_STEERING_ENV,
  WORKFLOW_DECISION_STEERING_HOST,
} from '@agimon-ai/workflow-mcp';

export function isStepStopGateEligible(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(
    environment[WORKFLOW_DECISION_FILE_ENV] &&
    environment[WORKFLOW_DECISION_STEERING_ENV] !== WORKFLOW_DECISION_STEERING_HOST &&
    !environment.PI_SUBAGENT_CHILD,
  );
}

/** A pane's root agent may settle to wait without spending a workflow reminder. */
export async function stepStopGate(
  environment: Readonly<Record<string, string | undefined>>,
  snapshot: DoomBackgroundWorkSnapshot | undefined,
): Promise<string | undefined> {
  if (!isStepStopGateEligible(environment)) return undefined;
  if (
    snapshot?.items.some(holdsSettledSession) ||
    snapshot?.errors.some((error) => BACKGROUND_WORK_HOLDING_PROVIDERS.includes(error.provider))
  )
    return undefined;
  const gate = await gateStepDecision(environment);
  return gate.action === 'block' ? gate.message : undefined;
}
