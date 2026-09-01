import { FileIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { mediaKindOf } from '../lib/media.ts';
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

export interface MediaPreviewProps {
  /** Where the bytes are served from. */
  src: string;
  /** The file's path, used for the accessible name and the download name. */
  path: string;
  /** Overrides the kind inferred from the path, for a server that knows better. */
  kind?: MediaKind;
  className?: string;
  'data-testid'?: string;
}

const FRAME = 'max-w-full rounded border border-doom-border bg-doom-deep';

export function MediaPreview({ src, path, kind, className, 'data-testid': testId }: MediaPreviewProps) {
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
      <video
        src={src}
        controls
        preload="metadata"
        data-testid={testId}
        data-kind={resolved}
        className={cn(FRAME, 'max-h-[36rem]', className)}
      >
        <track kind="captions" />
      </video>
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
