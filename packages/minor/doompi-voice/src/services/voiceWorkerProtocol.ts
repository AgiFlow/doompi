import type { AsrDecodingEvidence } from '../types/index.ts';
import type { NarrationBargeInEvidence } from './narrationBargeIn.ts';
import type { VoiceTranscriptSignalEvidence } from './transcriptAdmission.ts';

export const VOICE_WORKER_PROTOCOL_VERSION = 1 as const;
export const VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY = 'transcription-timeout';
export const VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY = 'ranked-barge-in';
export const VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY = 'intentional-barge-in';

export type VoiceWorkerMode = 'manual' | 'autonomous';
export type VoiceWorkerEngine = 'auto' | 'whisper-cpp' | 'openai-whisper' | 'mlx-whisper';

export interface VoiceWorkerAdapterConfiguration {
  binary?: string;
  model: { path?: string; id?: string };
}

export interface VoiceWorkerCaptureConfiguration {
  engine: VoiceWorkerEngine;
  language: string;
  recorder: { device: string; binary?: string };
  adapters: Partial<Record<Exclude<VoiceWorkerEngine, 'auto'>, VoiceWorkerAdapterConfiguration>>;
}
export type VoiceCaptureState = 'starting' | 'listening' | 'speech' | 'processing' | 'draining' | 'idle';
export type VoiceFinalizeReason = 'explicit-stop' | 'soft-endpoint' | 'duration-limit' | 'auto-disabled';
export type VoiceCandidateOutcome = 'committed' | 'discarded' | 'retry';

interface VoiceWorkerEnvelope {
  version: typeof VOICE_WORKER_PROTOCOL_VERSION;
  sequence: number;
}

export type VoiceWorkerCommand =
  | (VoiceWorkerEnvelope & {
      kind: 'initialize';
      spoolDirectory: string;
      activityHz: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'begin-capture';
      sessionId: string;
      captureId: string;
      mode: VoiceWorkerMode;
      turnId: string;
      config: VoiceWorkerCaptureConfiguration;
      maxDurationMs: number;
      utteranceIdleMs: number;
      transcriptionTimeoutMs?: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'finalize-capture';
      sessionId: string;
      captureId: string;
      reason: VoiceFinalizeReason;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'cancel-capture';
      sessionId: string;
      captureId: string;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'acknowledge-candidate';
      sessionId: string;
      turnId: string;
      revision: number;
      outcome: VoiceCandidateOutcome;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'playback-state';
      sessionId: string;
      playbackGeneration: number;
      active: boolean;
      referenceText?: string;
      startPhrases?: string[];
      stopPhrases?: string[];
    })
  | (VoiceWorkerEnvelope & {
      kind: 'confirm-barge-in';
      sessionId: string;
      captureId: string;
      turnId: string;
      playbackGeneration: number;
      outcome: 'promote' | 'discard';
    })
  | (VoiceWorkerEnvelope & {
      kind: 'shutdown';
      reason: 'session-shutdown' | 'extension-dispose';
    });

export type VoiceWorkerCommandPayload = VoiceWorkerCommand extends infer Command
  ? Command extends VoiceWorkerEnvelope
    ? Omit<Command, 'version' | 'sequence'>
    : never
  : never;

export type VoiceWorkerEvent =
  | (VoiceWorkerEnvelope & {
      kind: 'ready';
      capabilities: string[];
    })
  | (VoiceWorkerEnvelope & {
      kind: 'heartbeat';
      workerUptimeMs: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'activity';
      sessionId: string;
      captureId: string;
      state: VoiceCaptureState;
      elapsedMs: number;
      levelDbfs: number;
      speechProbability: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'capture-state';
      sessionId: string;
      captureId: string;
      state: VoiceCaptureState;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'endpoint-reached';
      sessionId: string;
      captureId: string;
      turnId: string;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'transcript-candidate';
      sessionId: string;
      captureId: string;
      turnId: string;
      revision: number;
      transcript: string;
      final: boolean;
      evidence?: VoiceTranscriptSignalEvidence;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'candidate-acknowledged';
      sessionId: string;
      captureId: string;
      turnId: string;
      revision: number;
      outcome: Exclude<VoiceCandidateOutcome, 'retry'>;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'barge-in-evidence';
      sessionId: string;
      captureId: string;
      turnId: string;
      playbackGeneration: number;
      evidence: NarrationBargeInEvidence;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'failure';
      code: string;
      recoverable: boolean;
      sessionId?: string;
      captureId?: string;
      turnId?: string;
      revision?: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'drained';
      sessionId: string;
      captureId: string;
      turnId?: string;
      revision?: number;
    })
  | (VoiceWorkerEnvelope & {
      kind: 'recovered';
      sessionId: string;
      turnId: string;
      revision: number;
      gapCount: number;
    });

export type VoiceWorkerEventPayload = VoiceWorkerEvent extends infer Event
  ? Event extends VoiceWorkerEnvelope
    ? Omit<Event, 'version' | 'sequence'>
    : never
  : never;

const RAW_AUDIO_KEYS = new Set(['audio', 'pcm', 'wav', 'buffer', 'arrayBuffer', 'rawAudio']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoRawAudio(value: unknown, seen = new WeakSet<object>()): void {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error('Voice worker control messages must not contain binary audio data.');
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawAudio(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (RAW_AUDIO_KEYS.has(key)) throw new Error(`Voice worker control messages must not contain ${key}.`);
    assertNoRawAudio(item, seen);
  }
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unexpected voice worker message field: ${unexpected}.`);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Voice worker field ${key} must be a string.`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`Voice worker field ${key} must be a boolean.`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Voice worker field ${key} must be a finite number.`);
  return value;
}

function requireBoundedNumber(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = requireNumber(record, key);
  if (value < minimum || value > maximum) throw new Error(`Voice worker field ${key} is out of range.`);
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = requireNumber(record, key);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Voice worker field ${key} must be a non-negative integer.`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireString(record, key);
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(record, key);
}

function optionalStrings(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    throw new Error(`Voice worker field ${key} must contain non-empty strings.`);
  return [...value];
}

function parseBargeInEvidence(value: unknown): NarrationBargeInEvidence {
  if (!isRecord(value)) throw new Error('Voice worker barge-in evidence must be an object.');
  assertExactKeys(value, [
    'exactStopCommand',
    'intentionalAddress',
    'classifierConfirmed',
    'classifierSpeechMs',
    'residualTokenCount',
    'residualRatio',
    'voicedMs',
    'peakDbAboveNoise',
    'signalVariationDb',
    'narrationSimilarity',
  ]);
  return {
    exactStopCommand: requireBoolean(value, 'exactStopCommand'),
    intentionalAddress: value.intentionalAddress === undefined ? false : requireBoolean(value, 'intentionalAddress'),
    ...(value.classifierConfirmed === undefined
      ? {}
      : { classifierConfirmed: requireBoolean(value, 'classifierConfirmed') }),
    ...(value.classifierSpeechMs === undefined
      ? {}
      : { classifierSpeechMs: requireNonNegativeInteger(value, 'classifierSpeechMs') }),
    residualTokenCount: requireNonNegativeInteger(value, 'residualTokenCount'),
    residualRatio: requireNumber(value, 'residualRatio'),
    voicedMs: requireNonNegativeInteger(value, 'voicedMs'),
    peakDbAboveNoise: requireNumber(value, 'peakDbAboveNoise'),
    signalVariationDb: requireNumber(value, 'signalVariationDb'),
    narrationSimilarity: requireNumber(value, 'narrationSimilarity'),
  };
}

function parseAsrEvidence(value: unknown): AsrDecodingEvidence {
  if (!isRecord(value)) throw new Error('Voice worker ASR evidence must be an object.');
  assertExactKeys(value, [
    'noSpeechProbability',
    'averageLogProbability',
    'compressionRatio',
    'segmentDurationMs',
    'speechDurationMs',
  ]);
  return {
    ...(value.noSpeechProbability === undefined
      ? {}
      : { noSpeechProbability: requireBoundedNumber(value, 'noSpeechProbability', 0, 1) }),
    ...(value.averageLogProbability === undefined
      ? {}
      : { averageLogProbability: requireBoundedNumber(value, 'averageLogProbability', -20, 0) }),
    ...(value.compressionRatio === undefined
      ? {}
      : { compressionRatio: requireBoundedNumber(value, 'compressionRatio', 0, 100) }),
    ...(value.segmentDurationMs === undefined
      ? {}
      : { segmentDurationMs: requireBoundedNumber(value, 'segmentDurationMs', 0, 300_000) }),
    ...(value.speechDurationMs === undefined
      ? {}
      : { speechDurationMs: requireBoundedNumber(value, 'speechDurationMs', 0, 300_000) }),
  };
}

function parseTranscriptEvidence(value: unknown): VoiceTranscriptSignalEvidence {
  if (!isRecord(value)) throw new Error('Voice worker transcript evidence must be an object.');
  assertExactKeys(value, [
    'durationMs',
    'voicedMs',
    'classifierSpeechMs',
    'rmsDbfs',
    'peakDbfs',
    'signalVariationDb',
    'nonZeroRatio',
    'gapCount',
    'playbackOverlapMs',
    'classifier',
    'asr',
  ]);
  return {
    durationMs: requireNumber(value, 'durationMs'),
    voicedMs: requireNumber(value, 'voicedMs'),
    classifierSpeechMs: requireNumber(value, 'classifierSpeechMs'),
    rmsDbfs: requireNumber(value, 'rmsDbfs'),
    peakDbfs: requireNumber(value, 'peakDbfs'),
    signalVariationDb: requireNumber(value, 'signalVariationDb'),
    nonZeroRatio: requireNumber(value, 'nonZeroRatio'),
    gapCount: requireNonNegativeInteger(value, 'gapCount'),
    playbackOverlapMs: requireNumber(value, 'playbackOverlapMs'),
    classifier: requireLiteral(value, 'classifier', ['client', 'host', 'energy']),
    ...(value.asr === undefined ? {} : { asr: parseAsrEvidence(value.asr) }),
  };
}

function requireLiteral<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = requireString(record, key);
  if (!values.includes(value as T)) throw new Error(`Voice worker field ${key} has an unsupported value.`);
  return value as T;
}

function parseAdapterConfiguration(value: unknown): VoiceWorkerAdapterConfiguration {
  if (!isRecord(value)) throw new Error('Voice worker adapter configuration must be an object.');
  assertExactKeys(value, ['binary', 'model']);
  if (!isRecord(value.model)) throw new Error('Voice worker adapter model must be an object.');
  assertExactKeys(value.model, ['path', 'id']);
  const binary = optionalString(value, 'binary');
  const modelPath = optionalString(value.model, 'path');
  const modelId = optionalString(value.model, 'id');
  if (!modelPath && !modelId) throw new Error('Voice worker adapter model requires a path or id.');
  return {
    ...(binary ? { binary } : {}),
    model: { ...(modelPath ? { path: modelPath } : {}), ...(modelId ? { id: modelId } : {}) },
  };
}

function parseCaptureConfiguration(value: unknown): VoiceWorkerCaptureConfiguration {
  if (!isRecord(value)) throw new Error('Voice worker capture configuration must be an object.');
  assertExactKeys(value, ['engine', 'language', 'recorder', 'adapters']);
  if (!isRecord(value.recorder)) throw new Error('Voice worker recorder configuration must be an object.');
  assertExactKeys(value.recorder, ['device', 'binary']);
  if (!isRecord(value.adapters)) throw new Error('Voice worker adapters configuration must be an object.');
  assertExactKeys(value.adapters, ['whisper-cpp', 'openai-whisper', 'mlx-whisper']);
  const recorderBinary = optionalString(value.recorder, 'binary');
  const adapters: VoiceWorkerCaptureConfiguration['adapters'] = {};
  for (const engine of ['whisper-cpp', 'openai-whisper', 'mlx-whisper'] as const) {
    const adapter = value.adapters[engine];
    if (adapter !== undefined) adapters[engine] = parseAdapterConfiguration(adapter);
  }
  return {
    engine: requireLiteral(value, 'engine', ['auto', 'whisper-cpp', 'openai-whisper', 'mlx-whisper']),
    language: requireString(value, 'language'),
    recorder: {
      device: requireString(value.recorder, 'device'),
      ...(recorderBinary ? { binary: recorderBinary } : {}),
    },
    adapters,
  };
}

function parseEnvelope(value: unknown): Record<string, unknown> {
  assertNoRawAudio(value);
  if (!isRecord(value)) throw new Error('Voice worker message must be an object.');
  if (value.version !== VOICE_WORKER_PROTOCOL_VERSION)
    throw new Error(`Unsupported voice worker protocol version: ${String(value.version)}.`);
  requireNonNegativeInteger(value, 'sequence');
  requireString(value, 'kind');
  return value;
}

export function parseVoiceWorkerCommand(value: unknown): VoiceWorkerCommand {
  const record = parseEnvelope(value);
  const envelope = {
    version: VOICE_WORKER_PROTOCOL_VERSION,
    sequence: requireNonNegativeInteger(record, 'sequence'),
  } as const;
  switch (record.kind) {
    case 'initialize':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'spoolDirectory', 'activityHz']);
      return {
        ...envelope,
        kind: 'initialize',
        spoolDirectory: requireString(record, 'spoolDirectory'),
        activityHz: requireNumber(record, 'activityHz'),
      };
    case 'begin-capture':
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'mode',
        'turnId',
        'config',
        'maxDurationMs',
        'utteranceIdleMs',
        'transcriptionTimeoutMs',
      ]);
      return {
        ...envelope,
        kind: 'begin-capture',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        mode: requireLiteral(record, 'mode', ['manual', 'autonomous']),
        turnId: requireString(record, 'turnId'),
        config: parseCaptureConfiguration(record.config),
        maxDurationMs: requireNonNegativeInteger(record, 'maxDurationMs'),
        utteranceIdleMs: requireNonNegativeInteger(record, 'utteranceIdleMs'),
        ...(record.transcriptionTimeoutMs === undefined
          ? {}
          : { transcriptionTimeoutMs: requireNonNegativeInteger(record, 'transcriptionTimeoutMs') }),
      };
    case 'finalize-capture':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'captureId', 'reason']);
      return {
        ...envelope,
        kind: 'finalize-capture',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        reason: requireLiteral(record, 'reason', ['explicit-stop', 'soft-endpoint', 'duration-limit', 'auto-disabled']),
      };
    case 'cancel-capture':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'captureId']);
      return {
        ...envelope,
        kind: 'cancel-capture',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
      };
    case 'acknowledge-candidate':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'turnId', 'revision', 'outcome']);
      return {
        ...envelope,
        kind: 'acknowledge-candidate',
        sessionId: requireString(record, 'sessionId'),
        turnId: requireString(record, 'turnId'),
        revision: requireNonNegativeInteger(record, 'revision'),
        outcome: requireLiteral(record, 'outcome', ['committed', 'discarded', 'retry']),
      };
    case 'playback-state': {
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'playbackGeneration',
        'active',
        'referenceText',
        'startPhrases',
        'stopPhrases',
      ]);
      const referenceText = optionalString(record, 'referenceText');
      const startPhrases = optionalStrings(record, 'startPhrases');
      const stopPhrases = optionalStrings(record, 'stopPhrases');
      return {
        ...envelope,
        kind: 'playback-state',
        sessionId: requireString(record, 'sessionId'),
        playbackGeneration: requireNonNegativeInteger(record, 'playbackGeneration'),
        active: requireBoolean(record, 'active'),
        ...(referenceText ? { referenceText } : {}),
        ...(startPhrases ? { startPhrases } : {}),
        ...(stopPhrases ? { stopPhrases } : {}),
      };
    }
    case 'confirm-barge-in':
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'turnId',
        'playbackGeneration',
        'outcome',
      ]);
      return {
        ...envelope,
        kind: 'confirm-barge-in',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        turnId: requireString(record, 'turnId'),
        playbackGeneration: requireNonNegativeInteger(record, 'playbackGeneration'),
        outcome: requireLiteral(record, 'outcome', ['promote', 'discard']),
      };
    case 'shutdown':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'reason']);
      return {
        ...envelope,
        kind: 'shutdown',
        reason: requireLiteral(record, 'reason', ['session-shutdown', 'extension-dispose']),
      };
    default:
      throw new Error(`Unsupported voice worker command: ${String(record.kind)}.`);
  }
}

export function parseVoiceWorkerEvent(value: unknown): VoiceWorkerEvent {
  const record = parseEnvelope(value);
  const envelope = {
    version: VOICE_WORKER_PROTOCOL_VERSION,
    sequence: requireNonNegativeInteger(record, 'sequence'),
  } as const;
  switch (record.kind) {
    case 'ready': {
      assertExactKeys(record, ['version', 'sequence', 'kind', 'capabilities']);
      const capabilities = record.capabilities;
      if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string'))
        throw new Error('Voice worker capabilities must be strings.');
      return { ...envelope, kind: 'ready', capabilities: [...capabilities] };
    }
    case 'heartbeat':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'workerUptimeMs']);
      return { ...envelope, kind: 'heartbeat', workerUptimeMs: requireNonNegativeInteger(record, 'workerUptimeMs') };
    case 'activity':
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'state',
        'elapsedMs',
        'levelDbfs',
        'speechProbability',
      ]);
      return {
        ...envelope,
        kind: 'activity',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        state: requireLiteral(record, 'state', ['starting', 'listening', 'speech', 'processing', 'draining', 'idle']),
        elapsedMs: requireNonNegativeInteger(record, 'elapsedMs'),
        levelDbfs: requireNumber(record, 'levelDbfs'),
        speechProbability: requireNumber(record, 'speechProbability'),
      };
    case 'capture-state':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'captureId', 'state']);
      return {
        ...envelope,
        kind: 'capture-state',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        state: requireLiteral(record, 'state', ['starting', 'listening', 'speech', 'processing', 'draining', 'idle']),
      };
    case 'endpoint-reached':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'captureId', 'turnId']);
      return {
        ...envelope,
        kind: 'endpoint-reached',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        turnId: requireString(record, 'turnId'),
      };
    case 'transcript-candidate': {
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'turnId',
        'revision',
        'transcript',
        'final',
        'evidence',
      ]);
      return {
        ...envelope,
        kind: 'transcript-candidate',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        turnId: requireString(record, 'turnId'),
        revision: requireNonNegativeInteger(record, 'revision'),
        transcript: requireString(record, 'transcript'),
        final: requireBoolean(record, 'final'),
        ...(record.evidence === undefined ? {} : { evidence: parseTranscriptEvidence(record.evidence) }),
      };
    }
    case 'candidate-acknowledged':
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'turnId',
        'revision',
        'outcome',
      ]);
      return {
        ...envelope,
        kind: 'candidate-acknowledged',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        turnId: requireString(record, 'turnId'),
        revision: requireNonNegativeInteger(record, 'revision'),
        outcome: requireLiteral(record, 'outcome', ['committed', 'discarded']),
      };
    case 'barge-in-evidence':
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'sessionId',
        'captureId',
        'turnId',
        'playbackGeneration',
        'evidence',
      ]);
      return {
        ...envelope,
        kind: 'barge-in-evidence',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        turnId: requireString(record, 'turnId'),
        playbackGeneration: requireNonNegativeInteger(record, 'playbackGeneration'),
        evidence: parseBargeInEvidence(record.evidence),
      };
    case 'failure': {
      assertExactKeys(record, [
        'version',
        'sequence',
        'kind',
        'code',
        'recoverable',
        'sessionId',
        'captureId',
        'turnId',
        'revision',
      ]);
      const sessionId = optionalString(record, 'sessionId');
      const captureId = optionalString(record, 'captureId');
      const turnId = optionalString(record, 'turnId');
      const revision = optionalInteger(record, 'revision');
      return {
        ...envelope,
        kind: 'failure',
        code: requireString(record, 'code'),
        recoverable: requireBoolean(record, 'recoverable'),
        ...(sessionId ? { sessionId } : {}),
        ...(captureId ? { captureId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(revision === undefined ? {} : { revision }),
      };
    }
    case 'drained': {
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'captureId', 'turnId', 'revision']);
      const turnId = optionalString(record, 'turnId');
      const revision = optionalInteger(record, 'revision');
      return {
        ...envelope,
        kind: 'drained',
        sessionId: requireString(record, 'sessionId'),
        captureId: requireString(record, 'captureId'),
        ...(turnId ? { turnId } : {}),
        ...(revision === undefined ? {} : { revision }),
      };
    }
    case 'recovered':
      assertExactKeys(record, ['version', 'sequence', 'kind', 'sessionId', 'turnId', 'revision', 'gapCount']);
      return {
        ...envelope,
        kind: 'recovered',
        sessionId: requireString(record, 'sessionId'),
        turnId: requireString(record, 'turnId'),
        revision: requireNonNegativeInteger(record, 'revision'),
        gapCount: requireNonNegativeInteger(record, 'gapCount'),
      };
    default:
      throw new Error(`Unsupported voice worker event: ${String(record.kind)}.`);
  }
}
