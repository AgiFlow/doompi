import { useEffect, useImperativeHandle, useRef } from 'react';
import { FileIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { mediaKindOf } from '../lib/media.ts';
import { boundedMediaTime } from '../lib/mediaPlayback.ts';
import type { MediaKind } from '../types/editor.ts';
import { Badge } from './Badge.tsx';
import { PdfPreview, type PdfPreviewController } from './PdfPreview.tsx';
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

export interface MediaIntrinsicSize {
  width: number;
  height: number;
}

export interface MediaFrameMetadata {
  mediaTime: number;
  presentedFrames?: number;
}

export interface MediaFrameCapture {
  blob: Blob;
  width: number;
  height: number;
  timeSeconds: number;
  metadata?: MediaFrameMetadata;
}

export interface MediaPreviewController {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  getState: () => MediaPlaybackState;
  getIntrinsicSize: () => MediaIntrinsicSize | null;
  captureFrame: (type?: 'image/png' | 'image/jpeg', quality?: number) => Promise<MediaFrameCapture | null>;
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
  /** PDF-only page and geometry controller. */
  pdfControllerRef?: import('react').Ref<PdfPreviewController>;
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

export function mediaPreviewController(
  videoRef: { readonly current: HTMLVideoElement | null },
  frameMetadataRef: { readonly current: MediaFrameMetadata | undefined } = { current: undefined },
): MediaPreviewController {
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
    getIntrinsicSize: () => {
      const video = videoRef.current;
      return video === null || video.videoWidth <= 0 || video.videoHeight <= 0
        ? null
        : { width: video.videoWidth, height: video.videoHeight };
    },
    captureFrame: async (type = 'image/png', quality) => {
      const video = videoRef.current;
      if (video === null || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (context === null) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      if (blob === null) return null;
      return {
        blob,
        width: canvas.width,
        height: canvas.height,
        timeSeconds: video.currentTime,
        ...(frameMetadataRef.current === undefined ? {} : { metadata: { ...frameMetadataRef.current } }),
      };
    },
  };
}

function VideoPreview({ src, className, testId, controllerRef, onPlaybackStateChange }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameMetadataRef = useRef<MediaFrameMetadata | undefined>(undefined);
  const reportState = () => {
    const video = videoRef.current;
    if (video !== null) onPlaybackStateChange?.(mediaPlaybackState(video));
  };

  useImperativeHandle(controllerRef, () => mediaPreviewController(videoRef, frameMetadataRef), []);
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || video.requestVideoFrameCallback === undefined) return;
    let request = 0;
    const report: VideoFrameRequestCallback = (_now, metadata) => {
      frameMetadataRef.current = {
        mediaTime: metadata.mediaTime,
        ...(Number.isFinite(metadata.presentedFrames) ? { presentedFrames: metadata.presentedFrames } : {}),
      };
      request = video.requestVideoFrameCallback(report);
    };
    request = video.requestVideoFrameCallback(report);
    return () => video.cancelVideoFrameCallback(request);
  }, []);
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
  pdfControllerRef,
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
      <PdfPreview src={src} path={path} controllerRef={pdfControllerRef} data-testid={testId} className={className} />
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
