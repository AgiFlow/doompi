export interface TurnSpoolIdentity {
  sessionId: string;
  captureId: string;
  turnId: string;
}

export interface TurnSpoolManifest extends TurnSpoolIdentity {
  version: 1;
  committedBytes: number;
  utteranceStartByte?: number;
  captureGeneration: number;
  revision: number;
  gapCount: number;
  acknowledgedRevision?: number;
  acknowledgedOutcome?: 'committed' | 'discarded';
}

export interface TurnSnapshot {
  revision: number;
  wavPath: string;
  pcmBytes: number;
}

export interface ITurnSpool {
  readonly directory: string;
  snapshotManifest(): TurnSpoolManifest;
  setCaptureGeneration(generation: number): void;
  markUtteranceStart(byteOffset: number): void;
  append(pcm: Buffer): void;
  recordGap(): void;
  createSnapshot(): TurnSnapshot;
  acknowledge(revision: number, outcome: 'committed' | 'discarded'): void;
  readCommittedPcm(): Buffer;
  close(): void;
  remove(): void;
}
