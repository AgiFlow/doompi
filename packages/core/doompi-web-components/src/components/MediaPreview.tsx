import { useImperativeHandle, useRef } from 'react';
import { FileIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { mediaKindOf } from '../lib/media.ts';
import { boundedMediaTime } from '../lib/mediaPlayback.ts';
import type { MediaKind } from '../types/editor.ts';
import { Badge } from './Badge.tsx';

/**
 * A file the browser can show but not edit.
 *
 * It renders bytes a server is already serving, so the caller supplies the
 * URL and this decides only which element reads it. Everything the browser
 * cannot render is a download rather than a converted approximation: a `.docx`
 * turned into HTML is a different document, and offering to edit that one
 * would be offering to overwrite the real one with it.
 */

export interface MediaPlaybackState {
  playing: boolean;
  currentTime: number;
  duration: number;
}

export interface MediaPreviewController {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  getState: () => MediaPlaybackState;
}

export interface MediaPreviewProps {
  /** Where the bytes are served from. */
  src: string;
  /** The file's path, used for the accessible name and the download name. */
  path: string;
  /** Overrides the kind inferred from the path, for a server that knows better. */
  kind?: MediaKind;
  className?: string;
  'data-testid'?: string;
  /** Video-only controller. It is assigned while the video element is mounted. */
  controllerRef?: import('react').Ref<MediaPreviewController>;
  /** Reports browser playback state changes for video previews. */
  onPlaybackStateChange?: (state: MediaPlaybackState) => void;
}

const FRAME = 'max-w-full rounded border border-doom-border bg-doom-deep';

interface VideoPreviewProps {
  src: string;
  className?: string;
  testId?: string;
  controllerRef?: import('react').Ref<MediaPreviewController>;
  onPlaybackStateChange?: (state: MediaPlaybackState) => void;
}

export function mediaPlaybackState(video: HTMLVideoElement): MediaPlaybackState {
  return {
    playing: !video.paused && !video.ended,
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
  };
}

export function mediaPreviewController(videoRef: {
  readonly current: HTMLVideoElement | null;
}): MediaPreviewController {
  return {
    play: async () => {
      const video = videoRef.current;
      if (video !== null) await video.play();
    },
    pause: () => videoRef.current?.pause(),
    seek: (seconds) => {
      const video = videoRef.current;
      if (video !== null) video.currentTime = boundedMediaTime(seconds, video.duration);
    },
    getState: () => {
      const video = videoRef.current;
      return video === null ? { playing: false, currentTime: 0, duration: 0 } : mediaPlaybackState(video);
    },
  };
}

function VideoPreview({ src, className, testId, controllerRef, onPlaybackStateChange }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reportState = () => {
    const video = videoRef.current;
    if (video !== null) onPlaybackStateChange?.(mediaPlaybackState(video));
  };

  useImperativeHandle(controllerRef, () => mediaPreviewController(videoRef), []);

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      preload="metadata"
      data-testid={testId}
      data-kind="video"
      className={cn(FRAME, 'max-h-[36rem]', className)}
      onPlay={reportState}
      onPause={reportState}
      onTimeUpdate={reportState}
      onDurationChange={reportState}
      onEnded={reportState}
    >
      <track kind="captions" />
    </video>
  );
}

export function MediaPreview({
  src,
  path,
  kind,
  className,
  controllerRef,
  onPlaybackStateChange,
  'data-testid': testId,
}: MediaPreviewProps) {
  const resolved = kind ?? mediaKindOf(path);
  const name = path.split('/').at(-1) ?? path;

  if (resolved === 'image') {
    return (
      <a href={src} target="_blank" rel="noreferrer" data-testid={testId} data-kind={resolved}>
        <img src={src} alt={path} className={cn(FRAME, 'max-h-[36rem]', className)} />
      </a>
    );
  }
  if (resolved === 'video') {
    return (
      <VideoPreview
        src={src}
        className={className}
        controllerRef={controllerRef}
        onPlaybackStateChange={onPlaybackStateChange}
        testId={testId}
      />
    );
  }
  if (resolved === 'pdf') {
    return (
      <iframe
        src={src}
        title={path}
        data-testid={testId}
        data-kind={resolved}
        className={cn(FRAME, 'h-[36rem] w-full', className)}
      />
    );
  }
  return (
    <Badge
      asChild
      size="md"
      data-testid={testId}
      data-kind={resolved}
      className={cn('self-start bg-doom-panel text-doom-text hover:border-doom-blue/50', className)}
    >
      <a href={src} download={name}>
        <FileIcon className="h-3 w-3 shrink-0 text-doom-faint" />
        download {name}
      </a>
    </Badge>
  );
}
