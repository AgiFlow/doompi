import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { type VoiceTone, voiceActivityView } from './voiceActivityView.ts';

const TONE_DOT: Readonly<Record<VoiceTone, DotTone>> = {
  idle: 'muted',
  live: 'cyan',
  attention: 'yellow',
};

const TONE_TEXT: Readonly<Record<VoiceTone, string>> = {
  idle: 'text-doom-faint',
  live: 'text-doom-cyan',
  attention: 'text-doom-yellow',
};

/** Five bars that rise and fall while the microphone is open. */
function Meter({ tone }: { tone: VoiceTone }) {
  const bars = [3, 7, 5, 9, 4];
  return (
    <span aria-hidden className="flex h-3 items-end gap-[2px]">
      {bars.map((height, index) => (
        <span
          key={index}
          className={`w-[2px] animate-pulse rounded-[1px] ${tone === 'attention' ? 'bg-doom-yellow' : 'bg-doom-cyan'}`}
          style={{ height: `${String(height)}px`, animationDelay: `${String(index * 120)}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * The voice group's body in the activity dock.
 *
 * Voice is the one mode whose whole value is knowing it is on: a microphone
 * you cannot see is one you cannot trust. The session already publishes its
 * phase on the footer status, and this is where a browser can afford to spell
 * it out, so listening, hearing, transcribing and narrating each read as
 * themselves rather than as a word tucked inside a chip.
 */
export function VoiceActivitySection({ sessionId, sendSessionFrame, statuses }: WebPluginSlotProps) {
  const view = voiceActivityView(statuses['doom-voice']);
  const stopManualRecording = (): void => {
    if (sessionId !== null) sendSessionFrame(sessionId, { type: 'prompt', message: '/voice' });
  };
  return (
    <div data-testid="voice-activity" data-voice-phase={view.phase} className="flex flex-col gap-1.5 px-1">
      <span className="flex min-w-0 items-center gap-2">
        <Dot tone={TONE_DOT[view.tone]} pulse={view.active} />
        <span data-testid="voice-label" className={`flex-1 truncate text-[11px] font-bold ${TONE_TEXT[view.tone]}`}>
          {view.label}
        </span>
        {view.elapsed ? (
          <span data-testid="voice-elapsed" className="shrink-0 text-[10px] tabular-nums text-doom-yellow">
            {view.elapsed}
          </span>
        ) : null}
        {view.mode === 'manual' && view.phase === 'recording' ? (
          <Button
            variant="danger-outline"
            size="xs"
            data-testid="voice-recording-stop"
            title="stop recording and fill the prompt"
            onClick={stopManualRecording}
          >
            stop
          </Button>
        ) : null}
        {view.active ? <Meter tone={view.tone} /> : null}
      </span>
      {view.detail ? (
        <span data-testid="voice-detail" className="text-[9px] leading-relaxed text-doom-faint">
          {view.detail}
        </span>
      ) : null}
      {view.mode !== 'off' ? (
        <span className="text-[8px] font-bold tracking-[0.14em] text-doom-faint/70 uppercase">
          {view.mode === 'auto' ? 'autonomous capture' : 'one-shot dictation'}
        </span>
      ) : null}
    </div>
  );
}
