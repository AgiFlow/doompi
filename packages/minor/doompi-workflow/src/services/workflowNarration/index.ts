import type { WorkflowRunRecord, WorkflowStage } from '@agimon-ai/workflow-mcp';

/** Package-local narration sink; the Pi adapter binds it to the injected Cordis service. */
export interface WorkflowNarrationSink {
  narrate(text: string): void;
}

const RUNNING_STAGE: WorkflowStage = 'running';
const COMPLETED_STAGE: WorkflowStage = 'completed';
const ERROR_STAGE: WorkflowStage = 'error';

type NarratedWorkflow = Pick<WorkflowRunRecord, 'displayName' | 'stage'>;

/**
 * Translate an observed workflow lifecycle transition into generic speech.
 * Voice owns delivery and ignores requests while its minor mode is inactive.
 */
export function narrateWorkflowTransition(
  requester: WorkflowNarrationSink,
  record: NarratedWorkflow,
  previousStage: WorkflowStage | undefined,
  startedDuringSession: boolean,
): void {
  const newlyLaunched = previousStage === undefined && startedDuringSession;
  if (newlyLaunched) requester.narrate(`Workflow launched: ${record.displayName}.`);

  if (previousStage !== RUNNING_STAGE && !newlyLaunched) return;
  if (record.stage === COMPLETED_STAGE) requester.narrate(`Workflow succeeded: ${record.displayName}.`);
  if (record.stage === ERROR_STAGE) requester.narrate(`Workflow failed: ${record.displayName}.`);
}
