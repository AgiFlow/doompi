import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button, Dot, type DotTone } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';

import { type VoiceTone, voiceActivityView } from '../lib/voiceActivityView';
import { voiceMediaBrowserState, voiceRealtimeBrowserControls } from '../stores/voiceMediaWakeStore';

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
          className={`w-[2px] animate-pulse rounded-xs ${tone === 'attention' ? 'bg-doom-yellow' : 'bg-doom-cyan'}`}
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
  const browserState = useStore(voiceMediaBrowserState.store);
  const realtimeControls = useStore(voiceRealtimeBrowserControls.store);
  const realtime = browserState?.sessionId === sessionId ? browserState.realtime : undefined;
  const controls = realtimeControls?.sessionId === sessionId ? realtimeControls : undefined;
  if (realtime !== undefined) {
    const live = realtime.connection === 'connected';
    const detail = browserState?.realtimeOutputInterrupted
      ? 'output interrupted locally and will stay silent until this realtime session ends.'
      : realtime.error
        ? `${realtime.error} End realtime voice, then retry from the session.`
        : realtime.speaking
          ? 'assistant speaking'
          : realtime.muted
            ? 'microphone muted'
            : realtime.listening
              ? 'microphone live'
              : 'establishing secure media';
    return (
      <div
        data-testid="voice-activity"
        data-voice-phase={`realtime-${realtime.connection}`}
        className="flex flex-col gap-1.5 px-1"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Dot tone={realtime.connection === 'failed' ? 'yellow' : live ? 'cyan' : 'muted'} pulse={live} />
          <span
            data-testid="voice-label"
            className={`flex-1 truncate text-[11px] font-bold ${TONE_TEXT[live ? 'live' : 'attention']}`}
          >
            {realtime.connection === 'failed'
              ? 'realtime voice failed'
              : live
                ? 'realtime voice live'
                : 'connecting realtime voice'}
          </span>
          {controls !== undefined && live ? (
            <>
              <Button
                variant="subtle"
                size="xs"
                aria-pressed={realtime.muted}
                onClick={() => controls.mute(!realtime.muted)}
              >
                {realtime.muted ? 'unmute' : 'mute'}
              </Button>
              <Button
                variant="subtle"
                size="xs"
                title="Interrupt local output. Output stays silent until this realtime session ends."
                onClick={() => controls.interrupt()}
              >
                interrupt
              </Button>
            </>
          ) : null}
          {controls !== undefined ? (
            <Button variant="subtle" size="xs" onClick={() => controls.end()}>
              end
            </Button>
          ) : null}
        </span>
        <span data-testid="voice-detail" className="text-[9px] leading-relaxed text-doom-faint">
          {detail}
        </span>
        <span className="text-[8px] font-bold tracking-[0.14em] text-doom-faint/70 uppercase">browser realtime</span>
      </div>
    );
  }
  const mediaConflict =
    sessionId !== null &&
    browserState?.sessionId === sessionId &&
    browserState.phase === 'conflict' &&
    view.mode !== 'off';
  const tone: VoiceTone = mediaConflict ? 'attention' : view.tone;
  const sendCommand = (message: string): void => {
    if (sessionId !== null) sendSessionFrame(sessionId, { type: 'prompt', message });
  };
  const toggleAutonomousMicrophone = (): void => sendCommand(`/voice-auto ${view.microphoneMuted ? 'unmute' : 'mute'}`);
  const showAutonomousMicrophoneControl =
    !mediaConflict && view.mode === 'auto' && view.phase !== 'starting' && view.phase !== 'draining';
  return (
    <div
      data-testid="voice-activity"
      data-voice-phase={mediaConflict ? 'conflict' : view.phase}
      className="flex flex-col gap-1.5 px-1"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Dot tone={TONE_DOT[tone]} pulse={mediaConflict ? false : view.active} />
        <span data-testid="voice-label" className={`flex-1 truncate text-sm font-bold ${TONE_TEXT[tone]}`}>
          {mediaConflict ? 'microphone unavailable' : view.label}
        </span>
        {view.elapsed ? (
          <span data-testid="voice-elapsed" className="shrink-0 text-xs tabular-nums text-doom-yellow">
            {view.elapsed}
          </span>
        ) : null}
        {showAutonomousMicrophoneControl ? (
          <Button
            variant="subtle"
            size="xs"
            data-testid="voice-autonomous-microphone-toggle"
            aria-label={`${view.microphoneMuted ? 'unmute' : 'mute'} autonomous voice microphone`}
            aria-pressed={view.microphoneMuted}
            title={`${view.microphoneMuted ? 'unmute' : 'mute'} autonomous voice microphone`}
            onClick={toggleAutonomousMicrophone}
          >
            {view.microphoneMuted ? 'unmute' : 'mute'}
          </Button>
        ) : null}
        {!mediaConflict && view.active ? <Meter tone={view.tone} /> : null}
      </span>
      {mediaConflict || view.detail ? (
        <span data-testid="voice-detail" className="text-2xs leading-relaxed text-doom-faint">
          {mediaConflict
            ? 'another browser tab owns voice capture. Close it or stop voice there, then retry.'
            : view.detail}
        </span>
      ) : null}
      {view.mode !== 'off' ? (
        <span className="text-2xs font-bold tracking-wider text-doom-faint/70 uppercase">
          {view.mode === 'auto' ? 'autonomous capture' : 'one-shot dictation'}
        </span>
      ) : null}
    </div>
  );
}
