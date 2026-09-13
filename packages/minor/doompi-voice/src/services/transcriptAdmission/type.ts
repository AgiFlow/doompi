import type { AsrDecodingEvidence } from '../../types';
import type { VoiceCommandContext } from '../commandCorrection';

export type VoiceTranscriptClassifier = 'client' | 'host' | 'energy';

export interface VoiceTranscriptSignalEvidence {
  durationMs: number;
  voicedMs: number;
  classifierSpeechMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  signalVariationDb: number;
  nonZeroRatio: number;
  gapCount: number;
  playbackOverlapMs: number;
  classifier: VoiceTranscriptClassifier;
  asr?: AsrDecodingEvidence;
}

export interface RecentVoiceTranscript {
  text: string;
  acceptedAt: number;
}

export type VoiceTranscriptAdmissionReason =
  | 'accepted'
  | 'duplicate'
  | 'empty'
  | 'narration_echo'
  | 'no_speech'
  | 'review';

export interface VoiceTranscriptAdmissionAssessment {
  action: 'accept' | 'reject' | 'review';
  reason: VoiceTranscriptAdmissionReason;
  score: number;
  transcript: string;
  narrationOverlap: boolean;
  narrationSimilarity: number;
  residualText: string;
  evidence: VoiceTranscriptSignalEvidence;
  matchedGuards: string[];
}

export interface VoiceTranscriptAdmissionInput {
  transcript: string;
  evidence?: VoiceTranscriptSignalEvidence;
  observedAt: number;
  narrationOverlap: boolean;
  narrationReferences: readonly string[];
  recentTranscripts?: readonly RecentVoiceTranscript[];
}

export interface VoiceTranscriptAdjudicationInput {
  assessment: VoiceTranscriptAdmissionAssessment;
  narrationText?: string;
  context?: VoiceCommandContext;
}

export interface VoiceTranscriptAdjudicationDecision {
  admit: boolean;
  continuationSummary?: string;
  reason: 'user_speech' | 'echo' | 'no_speech' | 'duplicate' | 'uncertain';
}

export interface VoiceTranscriptAdmissionModelRequest {
  systemPrompt: string;
  input: string;
  maxTokens: number;
  cacheRetention: 'none';
  signal: AbortSignal;
}

export interface IVoiceTranscriptAdmissionModelClient {
  complete(request: VoiceTranscriptAdmissionModelRequest): Promise<string>;
}

export interface IVoiceTranscriptAdjudicator {
  decide(input: VoiceTranscriptAdjudicationInput, signal: AbortSignal): Promise<VoiceTranscriptAdjudicationDecision>;
}
