import type { TtsPlaybackReference } from '../../types';
import type { AudioActivityHistogram } from '../vad';
export type EchoProbeAction = 'continue' | 'interrupt' | 'ignore';

export type EchoProbeClassification =
  | 'classifier_error'
  | 'duplicate'
  | 'echo'
  | 'no_reference'
  | 'no_speech'
  | 'pressure'
  | 'residual_speech'
  | 'stale'
  | 'stop_phrase';

export interface EchoReference {
  generation: number;
  playback: TtsPlaybackReference;
  echoTailUntil?: number;
}

export interface EchoProbeInput {
  generation: number;
  revision: number;
  transcript: string;
  newUtterance: boolean;
  observedAt: number;
  reference?: EchoReference;
  activity: AudioActivityHistogram;
  stopPhrases: readonly string[];
}

export interface EchoProbeResult {
  generation: number;
  revision: number;
  action: EchoProbeAction;
  classification: EchoProbeClassification;
}

export interface ControlPhraseMatch {
  tokenIndex: number;
  tokenLength: number;
  phraseTokenLength: number;
}

export interface NarrationAlignment {
  aligned: boolean;
  similarity: number;
}

export interface NarrationResidualAnalysis {
  echoAligned: boolean;
  residualRuns: string[];
  /** Compatibility view for clean-lane consumers; never use it for playback stop matching. */
  residual: string;
}

export interface RollingEchoProbeState {
  generation?: number;
  activeRevision?: number;
  pendingRevision?: number;
  highestRevision: number;
}

export interface IEchoProbeClassifier {
  classify(input: EchoProbeInput, signal: AbortSignal): Promise<EchoProbeResult>;
}
