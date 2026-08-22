import { PCM_FRAME_BYTES, PCM_FRAME_MS } from './pcm.ts';

const PCM_VALUE_LIMIT = 32_768;
const DBFS_SCALE = 20;
const SILENCE_DBFS = -96;
const STARTUP_SPEECH_MARGIN_DB = 3;
const AMBIENT_REBASE_MARGIN_DB = 6;
const AMBIENT_STABILITY_DB = 3;
const AMBIENT_REBASE_MS = 1_500;
const AMBIENT_REBASE_RATE_SCALE = 0.1;
const SPEECH_TRANSITION_SCORE = 10;
const NEURAL_SPEECH_WEIGHT = 10;
const NEURAL_SPEECH_TRANSITION_SCORE = 20;
const AMBIENT_REBASE_SCORE = 12;

export interface AudioActivityBucket {
  levelDbAboveNoise: number;
  playbackOverlapMs: number;
}

export interface AudioActivityHistogram {
  bucketMs: number;
  buckets: AudioActivityBucket[];
  durationMs: number;
  noiseFloorDbfs: number;
  speechThresholdDbfs: number;
  voicedMs: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  forcedClose: boolean;
}

export interface VadSegment {
  pcm: Buffer;
  activityHistogram: AudioActivityHistogram;
}

export interface VadFrameMetadata {
  playbackOverlapMs?: number;
  narrationHandoff?: boolean;
  speechDetected?: boolean;
}

export interface VadPushResult {
  speechStarted: boolean;
  provisionalSpeechStarted: boolean;
  provisionalSpeechEnded: boolean;
  segment?: VadSegment;
}

export interface VadNoiseProfile {
  averageDbfs: number;
  observedMs: number;
}

export interface VadConfiguration {
  frameMs: number;
  startupCalibrationMs: number;
  preRollMs: number;
  minimumVoicedMs: number;
  trailingSilenceMs: number;
  maximumSegmentMs: number;
  bucketMs: number;
  noiseMarginDb: number;
  minimumThresholdDbfs: number;
  maximumThresholdDbfs: number;
  initialNoiseFloorDbfs: number;
  noiseLearningRate: number;
}

export const DEFAULT_VAD_CONFIGURATION: VadConfiguration = {
  frameMs: PCM_FRAME_MS,
  startupCalibrationMs: 500,
  preRollMs: 300,
  minimumVoicedMs: 120,
  trailingSilenceMs: 600,
  maximumSegmentMs: 30_000,
  bucketMs: 100,
  noiseMarginDb: 10,
  minimumThresholdDbfs: -50,
  maximumThresholdDbfs: -25,
  initialNoiseFloorDbfs: -60,
  noiseLearningRate: 0.05,
};

interface FrameRecord {
  pcm: Buffer;
  dbfs: number;
  voiced: boolean;
  playbackOverlapMs: number;
}

interface WeightedGuard {
  matched: boolean;
  weight: number;
}

function guardScore(guards: readonly WeightedGuard[]): number {
  return guards.reduce((score, guard) => score + (guard.matched ? guard.weight : 0), 0);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function finiteDbfs(value: number): number {
  return Number.isFinite(value) ? value : SILENCE_DBFS;
}

export function calculatePcmFrameDbfs(frame: Buffer): number {
  if (frame.length === 0 || frame.length % 2 !== 0) throw new Error('PCM frame must contain complete 16-bit samples');
  let squareSum = 0;
  const sampleCount = frame.length / 2;
  for (let offset = 0; offset < frame.length; offset += 2) {
    const value = frame.readInt16LE(offset) / PCM_VALUE_LIMIT;
    squareSum += value * value;
  }
  const rms = Math.sqrt(squareSum / sampleCount);
  return rms === 0 ? Number.NEGATIVE_INFINITY : DBFS_SCALE * Math.log10(rms);
}

export class AdaptiveVoiceActivityDetector {
  private readonly configuration: VadConfiguration;
  private readonly preRollFrames: FrameRecord[] = [];
  private activeFrames: FrameRecord[] = [];
  private consecutiveVoicedMs = 0;
  private trailingSilenceMs = 0;
  private active = false;
  private currentNoiseFloorDbfs: number;
  private startupCalibrationRemainingMs: number;
  private noiseObservedMs: number;
  private elevatedAverageDbfs: number | undefined;
  private elevatedDurationMs = 0;
  private provisionalStrongSignal = false;
  private provisionalVariation = false;

  constructor(configuration: VadConfiguration = DEFAULT_VAD_CONFIGURATION, noiseProfile?: VadNoiseProfile) {
    this.validate(configuration);
    this.configuration = { ...configuration };
    this.currentNoiseFloorDbfs = noiseProfile?.averageDbfs ?? configuration.initialNoiseFloorDbfs;
    this.noiseObservedMs = noiseProfile?.observedMs ?? 0;
    this.startupCalibrationRemainingMs = configuration.startupCalibrationMs;
  }

  get noiseFloorDbfs(): number {
    return this.currentNoiseFloorDbfs;
  }

  get noiseProfile(): VadNoiseProfile {
    return { averageDbfs: this.currentNoiseFloorDbfs, observedMs: this.noiseObservedMs };
  }

  get hasPendingSpeech(): boolean {
    return this.active || this.consecutiveVoicedMs > 0;
  }

  push(frame: Buffer, metadata: VadFrameMetadata = {}): VadPushResult {
    if (frame.length !== PCM_FRAME_BYTES)
      throw new Error(`VAD requires ${PCM_FRAME_BYTES}-byte ${this.configuration.frameMs} ms PCM frames`);
    const dbfs = calculatePcmFrameDbfs(frame);
    const playbackOverlapMs = Math.min(
      this.configuration.frameMs,
      Math.max(0, Math.floor(metadata.playbackOverlapMs ?? 0)),
    );
    const record: FrameRecord = {
      pcm: Buffer.from(frame),
      dbfs,
      voiced: dbfs > this.thresholdDbfs(),
      playbackOverlapMs,
    };

    if (this.active) return this.pushActive(record);

    const hadProvisionalSpeech = this.consecutiveVoicedMs > 0;
    const thresholdDbfs = this.thresholdDbfs();
    const strongSignal = record.voiced && finiteDbfs(dbfs) >= thresholdDbfs + STARTUP_SPEECH_MARGIN_DB;
    const calibrating =
      playbackOverlapMs === 0 &&
      this.startupCalibrationRemainingMs > 0 &&
      metadata.narrationHandoff !== true &&
      !strongSignal;
    if (calibrating) {
      this.learnNoise(dbfs);
      this.startupCalibrationRemainingMs = Math.max(0, this.startupCalibrationRemainingMs - this.configuration.frameMs);
      this.pushPreRoll(record);
      this.clearProvisionalSpeech();
      return {
        speechStarted: false,
        provisionalSpeechStarted: false,
        provisionalSpeechEnded: hadProvisionalSpeech,
      };
    }
    if (record.voiced) this.provisionalStrongSignal ||= strongSignal;
    if (playbackOverlapMs === 0) {
      if (record.voiced) {
        const varied = this.observeElevatedLevel(dbfs, thresholdDbfs);
        this.provisionalVariation ||= varied;
      } else {
        this.learnNoise(dbfs);
        this.clearElevatedCandidate();
      }
    }
    this.pushPreRoll(record);
    const speechEligible = record.voiced && metadata.speechDetected !== false;
    this.consecutiveVoicedMs = speechEligible ? this.consecutiveVoicedMs + this.configuration.frameMs : 0;
    if (!speechEligible) {
      this.provisionalStrongSignal = false;
      this.provisionalVariation = false;
    }
    const provisionalSpeechStarted = speechEligible && !hadProvisionalSpeech;
    const provisionalSpeechEnded = !speechEligible && hadProvisionalSpeech;
    const neuralSpeechAvailable = metadata.speechDetected !== undefined;
    const transitionScore = guardScore([
      {
        matched: this.consecutiveVoicedMs >= this.configuration.minimumVoicedMs,
        weight: 7,
      },
      { matched: this.provisionalStrongSignal, weight: 4 },
      { matched: this.provisionalVariation, weight: 3 },
      { matched: metadata.speechDetected === true, weight: neuralSpeechAvailable ? NEURAL_SPEECH_WEIGHT : 0 },
    ]);
    const requiredTransitionScore = neuralSpeechAvailable ? NEURAL_SPEECH_TRANSITION_SCORE : SPEECH_TRANSITION_SCORE;
    if (transitionScore < requiredTransitionScore) {
      return { speechStarted: false, provisionalSpeechStarted, provisionalSpeechEnded };
    }

    this.active = true;
    this.activeFrames = this.preRollFrames.splice(0);
    this.trailingSilenceMs = record.voiced ? 0 : this.configuration.frameMs;
    const forcedClose = this.activeFrames.length * this.configuration.frameMs >= this.configuration.maximumSegmentMs;
    return {
      speechStarted: true,
      provisionalSpeechStarted,
      provisionalSpeechEnded: false,
      ...(forcedClose ? { segment: this.finishSegment(true) } : {}),
    };
  }

  flush(): VadSegment | undefined {
    if (!this.active) {
      this.clearPending();
      return undefined;
    }
    return this.finishSegment(false);
  }

  reset(): void {
    this.clearPending();
  }

  private pushPreRoll(record: FrameRecord): void {
    this.preRollFrames.push(record);
    const maximumPreRollFrames = this.configuration.preRollMs / this.configuration.frameMs;
    while (this.preRollFrames.length > maximumPreRollFrames) this.preRollFrames.shift();
  }

  private pushActive(record: FrameRecord): VadPushResult {
    this.activeFrames.push(record);
    this.trailingSilenceMs = record.voiced ? 0 : this.trailingSilenceMs + this.configuration.frameMs;
    const durationMs = this.activeFrames.length * this.configuration.frameMs;
    if (durationMs >= this.configuration.maximumSegmentMs) {
      return {
        speechStarted: false,
        provisionalSpeechStarted: false,
        provisionalSpeechEnded: false,
        segment: this.finishSegment(true),
      };
    }
    if (this.trailingSilenceMs >= this.configuration.trailingSilenceMs) {
      return {
        speechStarted: false,
        provisionalSpeechStarted: false,
        provisionalSpeechEnded: false,
        segment: this.finishSegment(false),
      };
    }
    return { speechStarted: false, provisionalSpeechStarted: false, provisionalSpeechEnded: false };
  }

  private finishSegment(forcedClose: boolean): VadSegment {
    const frames = this.activeFrames;
    const noiseFloorDbfs = this.currentNoiseFloorDbfs;
    const speechThresholdDbfs = this.thresholdDbfs();
    const segment: VadSegment = {
      pcm: Buffer.concat(frames.map((frame) => frame.pcm)),
      activityHistogram: {
        bucketMs: this.configuration.bucketMs,
        buckets: this.createBuckets(frames, noiseFloorDbfs),
        durationMs: frames.length * this.configuration.frameMs,
        noiseFloorDbfs: round(noiseFloorDbfs),
        speechThresholdDbfs: round(speechThresholdDbfs),
        voicedMs: frames.filter((frame) => frame.voiced).length * this.configuration.frameMs,
        leadingSilenceMs: this.edgeSilenceMs(frames),
        trailingSilenceMs: this.edgeSilenceMs([...frames].reverse()),
        forcedClose,
      },
    };
    this.clearPending();
    return segment;
  }

  private createBuckets(frames: readonly FrameRecord[], noiseFloorDbfs: number): AudioActivityBucket[] {
    const framesPerBucket = this.configuration.bucketMs / this.configuration.frameMs;
    const buckets: AudioActivityBucket[] = [];
    for (let offset = 0; offset < frames.length; offset += framesPerBucket) {
      const bucketFrames = frames.slice(offset, offset + framesPerBucket);
      const levelDbAboveNoise = Math.max(...bucketFrames.map((frame) => finiteDbfs(frame.dbfs) - noiseFloorDbfs));
      buckets.push({
        levelDbAboveNoise: round(levelDbAboveNoise),
        playbackOverlapMs: Math.min(
          this.configuration.bucketMs,
          bucketFrames.reduce((total, frame) => total + frame.playbackOverlapMs, 0),
        ),
      });
    }
    return buckets;
  }

  private edgeSilenceMs(frames: readonly FrameRecord[]): number {
    let silentFrames = 0;
    for (const frame of frames) {
      if (frame.voiced) break;
      silentFrames += 1;
    }
    return silentFrames * this.configuration.frameMs;
  }

  private thresholdDbfs(): number {
    return Math.max(
      this.configuration.minimumThresholdDbfs,
      Math.min(this.configuration.maximumThresholdDbfs, this.currentNoiseFloorDbfs + this.configuration.noiseMarginDb),
    );
  }

  private learnNoise(dbfs: number, learningRate = this.configuration.noiseLearningRate): void {
    const sample = finiteDbfs(dbfs);
    this.currentNoiseFloorDbfs += learningRate * (sample - this.currentNoiseFloorDbfs);
    this.noiseObservedMs += this.configuration.frameMs;
  }

  private observeElevatedLevel(dbfs: number, thresholdDbfs: number): boolean {
    const sample = finiteDbfs(dbfs);
    const nearThreshold = sample <= thresholdDbfs + AMBIENT_REBASE_MARGIN_DB;
    if (!nearThreshold) {
      this.clearElevatedCandidate();
      return true;
    }
    const previousAverage = this.elevatedAverageDbfs ?? sample;
    const stable = Math.abs(sample - previousAverage) <= AMBIENT_STABILITY_DB;
    if (!stable) {
      this.elevatedAverageDbfs = sample;
      this.elevatedDurationMs = this.configuration.frameMs;
      return true;
    }
    this.elevatedAverageDbfs = previousAverage + this.configuration.noiseLearningRate * (sample - previousAverage);
    this.elevatedDurationMs += this.configuration.frameMs;
    const rebaseScore = guardScore([
      { matched: nearThreshold, weight: 4 },
      { matched: stable, weight: 3 },
      { matched: this.elevatedDurationMs >= AMBIENT_REBASE_MS, weight: 5 },
    ]);
    if (rebaseScore >= AMBIENT_REBASE_SCORE) {
      this.learnNoise(dbfs, this.configuration.noiseLearningRate * AMBIENT_REBASE_RATE_SCALE);
    }
    return false;
  }

  private clearElevatedCandidate(): void {
    this.elevatedAverageDbfs = undefined;
    this.elevatedDurationMs = 0;
  }

  private clearProvisionalSpeech(): void {
    this.consecutiveVoicedMs = 0;
    this.provisionalStrongSignal = false;
    this.provisionalVariation = false;
    this.clearElevatedCandidate();
  }

  private clearPending(): void {
    this.preRollFrames.length = 0;
    this.activeFrames = [];
    this.clearProvisionalSpeech();
    this.trailingSilenceMs = 0;
    this.active = false;
  }

  private validate(configuration: VadConfiguration): void {
    const durationValues = [
      configuration.frameMs,
      configuration.preRollMs,
      configuration.minimumVoicedMs,
      configuration.trailingSilenceMs,
      configuration.maximumSegmentMs,
      configuration.bucketMs,
    ];
    if (durationValues.some((value) => !Number.isInteger(value) || value <= 0))
      throw new Error('VAD duration configuration must use positive integers');
    if (!Number.isInteger(configuration.startupCalibrationMs) || configuration.startupCalibrationMs < 0)
      throw new Error('VAD startup calibration must use a non-negative integer');
    if (
      configuration.startupCalibrationMs % configuration.frameMs !== 0 ||
      configuration.preRollMs % configuration.frameMs !== 0 ||
      configuration.minimumVoicedMs % configuration.frameMs !== 0 ||
      configuration.trailingSilenceMs % configuration.frameMs !== 0 ||
      configuration.maximumSegmentMs % configuration.frameMs !== 0 ||
      configuration.bucketMs % configuration.frameMs !== 0
    ) {
      throw new Error('VAD durations must align to the frame size');
    }
    if (configuration.frameMs !== PCM_FRAME_MS)
      throw new Error(`VAD frame size must remain ${PCM_FRAME_MS} ms for live PCM capture`);
    if (configuration.noiseLearningRate <= 0 || configuration.noiseLearningRate > 1)
      throw new Error('VAD noise learning rate must be greater than zero and at most one');
  }
}
