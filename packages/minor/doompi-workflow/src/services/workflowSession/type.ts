import type { DoomSessionActivity } from '@agimon-ai/doompi-core/hubChannel';

import type { WorkflowRunView } from '../../types/webWorkflows';

/** A notice posted into the workflow session's own conversation; it never starts a turn. */
export interface WorkflowSessionNotice {
  title: string;
  body: string;
  level: 'info' | 'error';
}

/** What a workflow session's lifecycle needs from its host, injected so it can be driven in a test. */
export interface WorkflowSessionLifecycleDeps {
  /** The session that launched this one; it alone may release it. */
  readonly parentSessionId: string | undefined;
  publishActivity?(activity: DoomSessionActivity | undefined): void;
  postNotice(notice: WorkflowSessionNotice): Promise<void>;
  /** True while the agent has no turn running and nothing queued. */
  isIdle(): Promise<boolean>;
  /** Asks the parent to release this session; false when the parent cannot hear it yet. */
  requestRelease?(parentSessionId: string, runKeys: readonly string[]): boolean;
  /** Calls back when the parent can hear this session again; returns the unsubscribe. */
  onPeerReady?(listener: (peerSessionId: string) => void): () => void;
}

export interface WorkflowSessionLifecycle {
  /** Feed the runs this session owns, each time they are published. */
  observe(runs: readonly WorkflowRunView[]): Promise<void>;
  /** An agent turn started here: the reader is engaged, so a success never releases the session. */
  agentStarted(): void;
  dispose(): void;
}
