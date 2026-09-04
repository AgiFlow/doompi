import type { SpeechPresenceDetector } from './clientCaptureActivity.ts';

export const VOICE_MEDIA_API_BASE_PATH = 'voice-media';
export const VOICE_MEDIA_PROTOCOL_VERSION = 6;
export const VOICE_MEDIA_SAMPLE_RATE = 16_000;
export const VOICE_MEDIA_CHANNELS = 1;
export const VOICE_MEDIA_BITS_PER_SAMPLE = 16;
export const VOICE_MEDIA_CONTENT_TYPE = 'application/vnd.doompi.pcm-s16le';
export const VOICE_MEDIA_ACTIVITY_STATE_HEADER = 'x-doompi-voice-activity-state';
export const VOICE_MEDIA_PLAYBACK_STATE_HEADER = 'x-doompi-playback-state';
export const VOICE_MEDIA_ACTIVITY_LEVEL_HEADER = 'x-doompi-voice-activity-level';
export const VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER = 'x-doompi-voice-activity-elapsed';
export const VOICE_MEDIA_ACTIVITY_EPOCH_HEADER = 'x-doompi-voice-activity-epoch';
export const VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER = 'x-doompi-voice-activity-speech-ms';
export const VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER = 'x-doompi-voice-activity-echo-speech-ms';
export const VOICE_MEDIA_WAKE_TYPE = 'voice_media_wake';
export const VOICE_MEDIA_HEARTBEAT_MS = 5_000;
export const VOICE_MEDIA_EVENT_WAIT_NONE = '0';

export const VOICE_MEDIA_ROUTES = {
  clientConnect: '/client/connect',
  clientDisconnect: '/client/disconnect',
  clientEvents: '/client/events',
  clientHeartbeat: '/client/heartbeat',
  clientAudio: '/client/audio',
  clientCaptureStopped: '/client/capture-stopped',
  clientPlaybackAudio: '/client/playback-audio',
  clientPlaybackResult: '/client/playback-result',
  hostCaptureStart: '/host/capture/start',
  hostCaptureAudio: '/host/capture/audio',
  hostCaptureStop: '/host/capture/stop',
  hostCaptureAbort: '/host/capture/abort',
  hostPlaybackStart: '/host/playback/start',
  hostPlaybackAudio: '/host/playback/audio',
  hostPlaybackAudioEnd: '/host/playback/audio-end',
  hostPlaybackResult: '/host/playback/result',
  hostPlaybackStop: '/host/playback/stop',
  hostPlaybackAbort: '/host/playback/abort',
} as const;

export type VoiceClientKind = 'browser' | 'native';
export type VoiceMediaControlLocation = 'local' | 'remote';

export interface VoiceMediaCapabilities {
  capture: boolean;
  playback: boolean;
  captureActivity: boolean;
  autonomousOrchestration: boolean;
  playbackDucking?: boolean;
}

export type VoiceMediaCaptureMode = 'manual' | 'autonomous';
export type VoiceMediaPlaybackDelivery = 'client' | 'streamed';
export type VoiceMediaCaptureActivityState = 'listening' | 'speech' | 'endpoint';

export interface VoiceMediaCaptureActivity {
  state: VoiceMediaCaptureActivityState;
  levelDbfs: number;
  elapsedMs: number;
  epoch?: number;
  classifiedSpeechMs?: number;
  echoDiscriminatedSpeechMs?: number;
}

export interface VoiceMediaCaptureConfiguration {
  mode: VoiceMediaCaptureMode;
  activityControl: 'host' | 'client';
  endpointSilenceMs?: number;
}

export interface VoiceMediaConnectRequest {
  version: typeof VOICE_MEDIA_PROTOCOL_VERSION;
  clientId: string;
  connectionId: string;
  clientKind: VoiceClientKind;
  controlLocation: VoiceMediaControlLocation;
  capabilities: VoiceMediaCapabilities;
}

export interface VoiceMediaWake {
  eventEpoch: string;
  sequence: number;
}

export interface VoiceMediaConnectResult {
  version: typeof VOICE_MEDIA_PROTOCOL_VERSION;
  cursor: number;
  eventEpoch?: string;
  heartbeatMs?: number;
}

export type VoiceMediaHeartbeatResult = VoiceMediaWake;

export type VoiceMediaClientEvent =
  | {
      sequence: number;
      type: 'capture-start';
      captureId: string;
      sampleRate: typeof VOICE_MEDIA_SAMPLE_RATE;
      channels: typeof VOICE_MEDIA_CHANNELS;
      bitsPerSample: typeof VOICE_MEDIA_BITS_PER_SAMPLE;
      configuration: VoiceMediaCaptureConfiguration;
    }
  | { sequence: number; type: 'capture-stop'; captureId: string }
  | { sequence: number; type: 'capture-abort'; captureId: string }
  | {
      sequence: number;
      type: 'playback-start';
      playbackId: string;
      text: string;
      delivery?: VoiceMediaPlaybackDelivery;
      voice?: string;
      rate?: number;
    }
  | { sequence: number; type: 'playback-stop'; playbackId: string }
  | { sequence: number; type: 'playback-abort'; playbackId: string };

export type VoiceMediaPlaybackOutcome = 'completed' | 'stopped' | 'aborted' | 'failed';

export interface VoiceMediaPlaybackResult {
  playbackId: string;
  outcome: VoiceMediaPlaybackOutcome;
  error?: string;
}

export interface VoiceMediaTransport {
  connect(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<VoiceMediaConnectResult>;
  /** Refreshes optional capabilities without changing active work or event position. */
  refreshCapabilities?(clientId: string, connectionId: string, capabilities: VoiceMediaCapabilities): Promise<void>;
  disconnect(clientId: string, connectionId: string): Promise<void>;
  nextEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined>;
  sendAudio(
    clientId: string,
    connectionId: string,
    captureId: string,
    pcm: Uint8Array,
    activity?: VoiceMediaCaptureActivity,
  ): Promise<void>;
  captureStopped(clientId: string, connectionId: string, captureId: string, error?: string): Promise<void>;
  receivePlaybackAudio?(
    clientId: string,
    connectionId: string,
    playbackId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  playbackFinished(clientId: string, connectionId: string, result: VoiceMediaPlaybackResult): Promise<void>;
}

export interface VoiceMediaCapture {
  stop(): Promise<void>;
}

/** Optional browser-local speech input. The original capture PCM remains authoritative for transport. */
export interface VoiceMediaCaptureSpeechAnalysis {
  speechPcm: Uint8Array;
  echoReferenceActive: boolean;
  echoDiscriminated: boolean;
}

export interface VoiceMediaPlayback {
  readonly completion: Promise<VoiceMediaPlaybackResult>;
  stop(outcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'>): void;
  duck?(targetGain: number, fadeMs: number, holdMs: number): void;
}

/** Client hardware boundary. Browser and future native clients implement the same contract. */
export interface VoiceMediaDevice {
  readonly capabilities: VoiceMediaCapabilities;
  /** Initializes optional authoritative media processors after baseline capabilities are available. */
  prepare?(): Promise<void>;
  createSpeechPresenceDetector?(): SpeechPresenceDetector | undefined;
  startCapture(
    onPcm: (pcm: Uint8Array, speechAnalysis?: VoiceMediaCaptureSpeechAnalysis) => void,
  ): Promise<VoiceMediaCapture>;
  speak(
    request: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>,
    audio?: Promise<Uint8Array>,
  ): VoiceMediaPlayback;
  close(): Promise<void>;
}

export function voiceMediaClientUrl(sessionId: string, route: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ session: sessionId, ...params });
  return `/api/plugin/${VOICE_MEDIA_API_BASE_PATH}${route}?${search.toString()}`;
}
