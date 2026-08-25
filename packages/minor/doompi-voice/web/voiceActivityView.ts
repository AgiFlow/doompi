/**
 * Reading the voice status line the session publishes.
 *
 * Voice reports itself through one footer status string, which is all a TUI
 * needs beside its spinner. A cockpit has room to say more, so the string is
 * parsed back into the state it describes: the phase, whether anything is
 * happening right now, and the elapsed time a recording carries.
 */

/** The braille spinner frames the manual indicator prefixes to its status. */
const SPINNER = /^[⠀-⣿]\s*/u;
const AUTO_PREFIX = 'voice auto:';
const MANUAL_PREFIX = 'voice:';
/** `recording 1:07` carries how long the microphone has been open. */
const ELAPSED = /\b(\d+:[0-5]\d)\b/u;

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'hearing'
  | 'processing'
  | 'narrating'
  | 'confirming'
  | 'waiting'
  | 'draining'
  | 'recording'
  | 'transcribing';

export type VoiceTone = 'idle' | 'live' | 'attention';

export interface VoiceActivityView {
  /** 'auto' while autonomous capture runs, 'manual' for one-shot dictation, 'off' when nothing is. */
  mode: 'auto' | 'manual' | 'off';
  phase: VoicePhase;
  /** The phase in words, for the panel's headline. */
  label: string;
  /** What the phase means, or the empty string when the label says it all. */
  detail: string;
  tone: VoiceTone;
  /** True while the microphone is open or work is in flight; the dot pulses on this. */
  active: boolean;
  /** `1:07` while a manual recording runs, empty otherwise. */
  elapsed: string;
}

const IDLE: VoiceActivityView = {
  mode: 'off',
  phase: 'idle',
  label: 'not listening',
  detail: 'start autonomous capture from the minor modes, or dictate one message with the voice tool.',
  tone: 'idle',
  active: false,
  elapsed: '',
};

const AUTO_PHASES: { match: string; phase: VoicePhase; label: string; detail: string; tone: VoiceTone }[] = [
  {
    match: 'hearing speech',
    phase: 'hearing',
    label: 'hearing you',
    detail: 'speech detected; it will transcribe when you pause.',
    tone: 'live',
  },
  {
    match: 'processing while listening',
    phase: 'processing',
    label: 'transcribing',
    detail: 'still listening while it works out what you said.',
    tone: 'live',
  },
  {
    match: 'narrating and listening',
    phase: 'narrating',
    label: 'narrating',
    detail: 'reading the reply aloud, and still listening.',
    tone: 'live',
  },
  {
    match: 'confirmation needed',
    phase: 'confirming',
    label: 'needs confirmation',
    detail: 'it is waiting on an answer before it acts.',
    tone: 'attention',
  },
  {
    match: 'waiting for keyboard input',
    phase: 'waiting',
    label: 'waiting for the keyboard',
    detail: 'something asked for typed input, so capture is paused.',
    tone: 'attention',
  },
  {
    match: 'draining',
    phase: 'draining',
    label: 'stopping',
    detail: 'finishing what it already heard.',
    tone: 'attention',
  },
  { match: 'listening', phase: 'listening', label: 'listening', detail: '', tone: 'live' },
];

/** The voice panel's state, read from the raw `doom-voice` status the session published. */
export function voiceActivityView(status: string | undefined): VoiceActivityView {
  const raw = (status ?? '').replace(SPINNER, '').trim();
  if (raw === '') return IDLE;

  if (raw.startsWith(AUTO_PREFIX)) {
    const rest = raw.slice(AUTO_PREFIX.length).trim();
    const found = AUTO_PHASES.find((candidate) => rest.includes(candidate.match));
    if (!found) return { ...IDLE, mode: 'auto', label: rest || 'listening', detail: '', tone: 'live', active: true };
    return {
      mode: 'auto',
      phase: found.phase,
      label: found.label,
      detail: found.detail,
      tone: found.tone,
      active: true,
      elapsed: '',
    };
  }

  if (raw.startsWith(MANUAL_PREFIX)) {
    const rest = raw.slice(MANUAL_PREFIX.length).trim();
    const recording = rest.startsWith('recording');
    return {
      mode: 'manual',
      phase: recording ? 'recording' : 'transcribing',
      label: recording ? 'recording' : 'transcribing',
      detail: recording ? 'the microphone is open; it sends when you stop.' : 'turning what you said into text.',
      tone: recording ? 'attention' : 'live',
      active: true,
      elapsed: recording ? (ELAPSED.exec(rest)?.[1] ?? '') : '',
    };
  }

  // An unfamiliar line is still the session talking, so it is shown as it came.
  return { mode: 'auto', phase: 'listening', label: raw, detail: '', tone: 'live', active: true, elapsed: '' };
}
