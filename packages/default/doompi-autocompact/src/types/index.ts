import type { ContextEvent } from '@earendil-works/pi-coding-agent';

export type AutocompactPass = 1 | 2 | 3;
export type AutocompactMessage = ContextEvent['messages'][number];
export type AutocompactPhase = 'waiting' | 'checkpoint_pending' | 'checkpoint_ready' | 'compacting';

/** Configured pass ratios, keyed by pass; an absent pass keeps its default. */
export type AutocompactRatioOverrides = Partial<Record<AutocompactPass, number>>;

export interface AutocompactFileDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface AutocompactState extends AutocompactFileDetails {
  version: 2;
  cycle: number;
  pass: AutocompactPass;
  phase: AutocompactPhase;
  checkpointQueue: AutocompactPass[];
  exhaustedPasses: AutocompactPass[];
  invalidAttempts: number;
  baselineTokens: number;
  baselinePending: boolean;
  requestId?: string;
  compactionPass?: 2 | 3;
  latestCheckpointSnapshotLeafId?: string;
  lastAttemptLeafId?: string;
  snapshotLeafId?: string;
  snapshotTokens?: number;
  pendingCheckpoint?: string;
}

export interface CheckpointDecision {
  summary: string;
  shouldCompact?: boolean;
}

export interface CheckpointRequestDetails {
  version: 2;
  cycle: number;
  pass: AutocompactPass;
  requestId: string;
}

export interface AutocompactContextDetails extends AutocompactFileDetails {
  doomAutocompact: {
    version: 2;
    cycle: number;
    pass: 2 | 3;
    requestId: string;
    snapshotLeafId: string;
    tokensBefore: number;
  };
  retainedMessages: AutocompactMessage[];
}

export interface ContextProjection {
  messages: AutocompactMessage[];
  marker?: AutocompactContextDetails['doomAutocompact'];
  invalidMarker?: boolean;
  retainedMessageCount: number;
}
