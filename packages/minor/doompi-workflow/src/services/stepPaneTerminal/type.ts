import type { WorkflowRunRecord } from '@agimon-ai/workflow-mcp';

/** Where a step ran, when a host executor placed it. */
export interface StepRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
}

/**
 * What one terminal request reads: a run, and optionally the step whose pane it
 * wants. Without a step it follows whichever pane is current, which reaches only
 * one of a parallel group's panes.
 */
export interface RunTerminalTarget {
  readonly record: WorkflowRunRecord;
  /** A step ref's id, as its progress event recorded it. */
  readonly step?: string;
}

/** The refs a run's terminal is chosen from, folded from its progress log. */
export interface RunStepRefs {
  /** The latest-started step still running, when a host executor placed it. */
  readonly current?: StepRef;
  /** Every step still running that a host executor placed; more than one inside a parallel group. */
  readonly running?: readonly StepRef[];
  /** The latest command step's pane, running or finished. */
  readonly lastPane?: StepRef;
  /** Every ref the run recorded, each once, so a request can name any step's pane. */
  readonly known?: readonly StepRef[];
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
