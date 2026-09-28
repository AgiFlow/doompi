import type { DoomHubSessionService } from '@agimon-ai/doompi-core/hubChannel';

/** The part of the hub session service a customRun step drives. */
export type StepSessionService = Pick<DoomHubSessionService, 'create' | 'prompt' | 'abort'>;

export interface StepPaneRequest {
  /** Unique per step execution; it names the pane. */
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** A command running in its own terminal pane. */
export interface StepPane {
  /** Where a terminal view reaches the pane: the socket that serves it. */
  readonly target: string;
  readonly completion: Promise<{ exitCode: number }>;
  stop(): Promise<boolean>;
}

/** Opens a terminal pane for one command, or undefined when no multiplexer is available. */
export type StepPaneLauncher = (request: StepPaneRequest) => Promise<StepPane | undefined>;

export interface StepExecutorDependencies {
  readonly sessionService: StepSessionService;
  /** The session that launched the workflow; every step session becomes its child. */
  readonly parentSessionId: string;
  /** What this process already runs with. Only what a step adds or changes is handed to its session. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly launchPane?: StepPaneLauncher;
  readonly createId: () => string;
}
