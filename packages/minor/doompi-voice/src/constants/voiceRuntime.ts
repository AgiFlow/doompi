import { DOOM_VOICE_SOURCE } from '../constants/voiceTools';

export const VOICE_SOURCE = DOOM_VOICE_SOURCE;

export const TRANSFER_VOICE_SOURCE = `${DOOM_VOICE_SOURCE}#transfer-voice`;

export const STATUS_KEY = 'doom-voice';

export const MAX_RECORDING_MS = 300_000;

export const ACTIVITY_INTERVAL_MS = 120;

export const LEADER_GROUP_ORDER = 67;

export const AUTO_LEADER_DETAIL = 'autonomous capture with agent narration';

export const AUTO_MODE_LABEL = 'Voice';

export const AUTO_MODE_COLOR = 'accent' as const;

export const RECORDING_FRAMES = ['·', '•', '●', '•'] as const;

export const TRANSCRIBING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const INFO_NOTIFICATION = 'info';

export const ERROR_NOTIFICATION = 'error';

export const RECORDING_REQUESTED_EVENT = 'doom_voice.recording_requested';

export const RECORDING_STARTED_EVENT = 'doom_voice.recording_started';

export const RECORDING_FAILED_EVENT = 'doom_voice.recording_failed';

export const RECORDING_FINISHED_EVENT = 'doom_voice.recording_finished';

export const TRANSCRIPTION_STARTED_EVENT = 'doom_voice.transcription_started';

export const TRANSCRIPTION_FINISHED_EVENT = 'doom_voice.transcription_finished';

export const TRANSCRIPTION_FAILED_EVENT = 'doom_voice.transcription_failed';

export const IDLE_STATE = 'idle' as const;

export const RECORDING_STATE = 'recording' as const;

export const TRANSCRIBING_STATE = 'transcribing' as const;

export const VOICE_GROUP_SEGMENT = {
  key: 'v',
  label: 'voice',
  detail: 'dictation and narration',
  order: LEADER_GROUP_ORDER,
} as const;
