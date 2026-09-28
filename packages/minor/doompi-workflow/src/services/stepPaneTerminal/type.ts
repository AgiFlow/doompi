import type { WorkflowRunRecord } from '@agimon-ai/workflow-mcp';

/** Where a step ran, when a host executor placed it. */
export interface StepRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
}

/** The refs a run's terminal is chosen from, folded from its progress log. */
export interface RunStepRefs {
  /** The step still running, when a host executor placed it. */
  readonly current?: StepRef;
  /** The latest command step's pane, running or finished. */
  readonly lastPane?: StepRef;
}

/** Reads a pane the step executor opened, addressed by its multiplexer target. */
export interface StepPaneClient {
  capture(target: string): Promise<string | undefined>;
  input(target: string, text: string): Promise<boolean>;
}

export interface StepPaneTerminalDependencies {
  stepRefs(record: WorkflowRunRecord): RunStepRefs;
  /** A client for the multiplexer the run's panes live on. */
  paneClient(record: WorkflowRunRecord): StepPaneClient;
  /** A finished pane's recorded output, or undefined when none was kept. */
  paneLog(record: WorkflowRunRecord, pane: StepRef): Promise<string | undefined>;
}
