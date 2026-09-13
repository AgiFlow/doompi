export {
  writePrivatePcm16Wav,
  analyzePcmWav,
  SystemClock,
  ExecutableResolver,
  NodeProcessSpawner,
  NodeBinaryProcessSpawner,
  TemporaryWorkspace,
  FfmpegAudioRecorder,
  FfmpegPcmAudioRecorder,
  MacOsSayTtsAdapter,
  MacOsSayPcmSynthesizer,
  PcmWavAnalyzer,
} from '../services/infrastructure';

export { voiceMediaHostConnection, ClientPcmAudioRecorder, ClientTtsAdapter } from '../services/clientMedia';
export type { ClientNarrationSynthesizer } from '../services/clientMedia';
export {
  voiceLeaderBindings,
  deliverAutoCaptureInput,
  createVoiceNarrationService,
  extractTerminalAssistantText,
  createVoiceTurnFallback,
  resolveVoiceCommandCorrector,
  resolveVoiceTranscriptAdjudicator,
  resolveVoiceFallbackNarrator,
  voiceToolRestriction,
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  WhisperCppAdapter,
} from '../controllers/voice';
export type {
  VoiceLeaderContributionHandle,
  VoiceFooterContributionHandle,
  AutoCaptureDeliveryIntent,
  AutoCapturePiEventController,
  VoiceNarrationServiceBinding,
  VoiceTurnFallbackRuntime,
  VoiceExtensionOptions,
} from '../controllers/voice';
export {
  compactVoiceCommandContext,
  phoneticKey,
  editDistance,
  MAX_VOICE_COMMAND_CONTEXT_BYTES,
  VoiceCommandCorrector,
} from '../services/commandCorrection';
export type {
  VoiceCommandContext,
  VoiceCommandCorrectionInput,
  VoiceCommandCorrectionModelRequest,
  IVoiceCommandCorrectionModelClient,
  IVoiceCommandCorrector,
} from '../services/commandCorrection';
export { DETERMINISTIC_FALLBACK_THRESHOLD_CHARACTERS, VoiceTurnFallbackNarrator } from '../services/fallbackNarration';
export type {
  FallbackNarrationModelRequest,
  IFallbackNarrationModelClient,
  FallbackNarrationSource,
  FallbackNarration,
  IVoiceTurnFallbackNarrator,
  IVoiceNarrationCompactor,
  VoiceTurnFallbackNarratorOptions,
} from '../services/fallbackNarration';
export { NarrationPlaybackCoordinator } from '../services/narration';
export type {
  NarrationPlaybackRequest,
  NarrationPlaybackOutcome,
  NarrationPlaybackSettlement,
  NarrationPlaybackLifecycleEvent,
  NarrationPlaybackLifecycleObserver,
  NarrationPlaybackLifecycleErrorObserver,
} from '../services/narration';
export { VoiceNarrationPlayback } from '../services/narrationPlayback';
export type { VoiceNarrationPlaybackLogger, VoiceNarrationPlaybackDependencies } from '../services/narrationPlayback';
export {
  encodePcm16Wav,
  PCM_SAMPLE_RATE,
  PCM_CHANNELS,
  PCM_BITS_PER_SAMPLE,
  PCM_FRAME_MS,
  PCM_BYTES_PER_SAMPLE,
  PCM_FRAME_BYTES,
  PcmFrameAssembler,
} from '../services/pcm';

export {
  normalizeEchoText,
  matchStartPhrase,
  matchStopPhrase,
  matchPlaybackStopPhrase,
  alignNarrationSpan,
  extractNovelNarrationResidual,
  EchoTailTimeline,
  SemanticEchoAdjudicator,
  RollingEchoProbeCoordinator,
} from '../services/semanticEcho';
export type {
  EchoProbeAction,
  EchoProbeClassification,
  EchoReference,
  EchoProbeInput,
  EchoProbeResult,
  ControlPhraseMatch,
  NarrationAlignment,
  NarrationResidualAnalysis,
  RollingEchoProbeState,
  IEchoProbeClassifier,
} from '../services/semanticEcho';
export { DEFAULT_UTTERANCE_LIMITS, UtteranceAssembler, BoundedTranscriptionQueue } from '../services/utterance';
export type { UtteranceLimits, UtteranceFinalizationReason, PendingUtterance } from '../services/utterance';
export { calculatePcmFrameDbfs, DEFAULT_VAD_CONFIGURATION, AdaptiveVoiceActivityDetector } from '../services/vad';
export type {
  AudioActivityBucket,
  AudioActivityHistogram,
  VadSegment,
  VadFrameMetadata,
  VadPushResult,
  VadNoiseProfile,
  VadConfiguration,
} from '../services/vad';
export type {
  VoiceDependencies,
  VoiceState,
  AutoCaptureActivationState,
  AutoCaptureIndicatorState,
  TimerHandle,
  IClock,
  IExecutableResolver,
  ProcessResult,
  ProcessStartOptions,
  BinaryProcessStartOptions,
  RunningProcess,
  BinaryRunningProcess,
  IProcessSpawner,
  IBinaryProcessSpawner,
  ITemporaryWorkspace,
  RecordingHandle,
  IAudioRecorder,
  LiveRecordingHandle,
  PcmAudioRecorderStartOptions,
  IPcmAudioRecorder,
  VoiceMediaAudioPoll,
  IVoiceMediaHostConnection,
  ISpeechPresenceDetector,
  NarrationKind,
  TtsPlaybackOutcome,
  TtsSpeakRequest,
  TtsPlaybackReference,
  TtsPlaybackResult,
  TtsPlayback,
  ITtsAdapter,
  AudioAnalysis,
  IAudioAnalyzer,
  TranscriptionRequest,
  AsrDecodingEvidence,
  TranscriptionResult,
  TranscriptionAdapterOutput,
  ITranscriberAdapter,
  SelectedTranscriber,
  ITranscriberRegistry,
  VoiceActivityUpdate,
  VoiceUi,
  AutoCaptureUi,
  IVoiceSessionController,
} from '../types';
export {
  voiceMediaClientUrl,
  VOICE_MEDIA_API_BASE_PATH,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_SAMPLE_RATE,
  VOICE_MEDIA_CHANNELS,
  VOICE_MEDIA_BITS_PER_SAMPLE,
  VOICE_MEDIA_CONTENT_TYPE,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  VOICE_MEDIA_PLAYBACK_STATE_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER,
  VOICE_MEDIA_WAKE_TYPE,
  VOICE_MEDIA_HEARTBEAT_MS,
  VOICE_MEDIA_EVENT_WAIT_NONE,
  VOICE_MEDIA_ROUTES,
} from '../types/clientMedia';
export type {
  VoiceClientKind,
  VoiceMediaControlLocation,
  VoiceMediaCapabilities,
  VoiceMediaCaptureMode,
  VoiceMediaPlaybackDelivery,
  VoiceMediaCaptureActivityState,
  VoiceMediaCaptureActivity,
  VoiceMediaCaptureConfiguration,
  VoiceMediaConnectRequest,
  VoiceMediaWake,
  VoiceMediaConnectResult,
  VoiceMediaHeartbeatResult,
  VoiceMediaClientEvent,
  VoiceMediaPlaybackOutcome,
  VoiceMediaPlaybackResult,
  VoiceMediaTransport,
  VoiceMediaCapture,
  VoiceMediaCaptureSpeechAnalysis,
  VoiceMediaPlayback,
  VoiceMediaDevice,
} from '../types/clientMedia';
export { VoiceSessionController } from '../services/voiceSessionController';
export { PiVoiceConfigService } from '../services/voiceConfig';
export { createVoiceDependencies } from '../services/voiceDependencies';
export { canRunVoice, voiceModeState, voiceOwnershipState } from '../models/voiceMode';
export { formatVoiceActivity, formatAutoCaptureActivity } from '../models/voiceActivity';
export type {
  VoiceFooterContributionValue,
  VoiceActivityPresentation,
  AutoCaptureActivityPresentation,
} from '../models/voiceActivity';
