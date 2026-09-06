import { Button, type MediaPlaybackState } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

export function videoTimeLabel(seconds: number): string {
  const milliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function AuthorVideoControls({
  playback,
  ready,
  locked,
  marking,
  onSeek,
  onToggle,
  onAnnotate,
}: {
  playback: MediaPlaybackState;
  ready: boolean;
  locked: boolean;
  marking: boolean;
  onSeek: (seconds: number) => void;
  onToggle: () => void;
  onAnnotate: () => void;
}) {
  const [seconds, setSeconds] = useState('');
  const duration = playback.duration;
  const invalid =
    seconds.trim() === '' || !Number.isFinite(Number(seconds)) || Number(seconds) < 0 || Number(seconds) > duration;
  const buttonClass = 'min-h-11 px-3 text-sm [@media(pointer:fine)]:min-h-8 sm:text-xs';
  return (
    <section
      aria-label="Video annotation controls"
      className="mt-2 space-y-2 rounded border border-doom-border bg-doom-panel p-2.5 text-sm text-doom-text sm:text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <output aria-label="Playback position" className="font-mono text-sm tabular-nums">
          {videoTimeLabel(playback.currentTime)} / {videoTimeLabel(duration)}
        </output>
        <span className="text-doom-dim">
          {locked
            ? 'Annotation draft: add or discard it before seeking.'
            : marking
              ? 'Frame paused. Drag a region on the video.'
              : 'Seek to a moment, then choose Annotate this frame.'}
        </span>
      </div>
      <input
        aria-label="Video timeline"
        type="range"
        min={0}
        max={duration || 0}
        step={0.001}
        value={Math.min(playback.currentTime, duration)}
        disabled={locked || duration <= 0}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="h-11 w-full cursor-pointer accent-doom-blue [@media(pointer:fine)]:h-6"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button className={buttonClass} disabled={locked || duration <= 0} onClick={onToggle}>
          {playback.playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          className={buttonClass}
          disabled={locked || duration <= 0}
          onClick={() => onSeek(Math.max(0, playback.currentTime - 0.1))}
          aria-label="Seek back 0.1 seconds"
        >
          −0.1s
        </Button>
        <Button
          className={buttonClass}
          disabled={locked || duration <= 0}
          onClick={() => onSeek(Math.min(duration, playback.currentTime + 0.1))}
          aria-label="Seek forward 0.1 seconds"
        >
          +0.1s
        </Button>
        <Button variant="primary" className={buttonClass} disabled={locked || !ready} onClick={onAnnotate}>
          Annotate this frame
        </Button>
        <form
          className="flex flex-wrap items-center gap-2 sm:ml-auto"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && !locked) onSeek(Number(seconds));
          }}
        >
          <label htmlFor="author-video-seconds" className="text-doom-dim">
            Go to seconds
          </label>
          <input
            id="author-video-seconds"
            type="number"
            min={0}
            max={duration}
            step={0.001}
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
            disabled={locked || duration <= 0}
            placeholder="1.250"
            className="h-11 w-24 rounded border border-doom-border bg-doom-deep px-2 text-base [@media(pointer:fine)]:h-8 sm:text-xs"
          />
          <Button type="submit" className={buttonClass} disabled={locked || duration <= 0 || invalid}>
            Go
          </Button>
        </form>
      </div>
    </section>
  );
}
