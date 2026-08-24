import type { FileMention } from '../../lib/fileMentions.ts';
import { sessionFileUrl } from '../../../types/media.ts';

function Preview({ mention, url }: { mention: FileMention; url: string }) {
  if (mention.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={mention.path} className="max-h-[360px] max-w-full rounded border border-doom-border" />
      </a>
    );
  }
  if (mention.kind === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-[360px] max-w-full rounded border border-doom-border"
      />
    );
  }
  if (mention.kind === 'pdf') {
    return (
      <iframe
        src={url}
        title={mention.path}
        className="h-[480px] w-full rounded border border-doom-border bg-doom-deep"
      />
    );
  }
  return (
    <a
      href={url}
      className="inline-flex items-center gap-1.5 self-start rounded border border-doom-border bg-doom-panel px-2.5 py-1 text-[11px] text-doom-text hover:border-doom-blue/50"
    >
      <span className="text-doom-faint">&#9776;</span>
      {mention.path}
    </a>
  );
}

/**
 * The files a message mentioned with @, shown under its text. The hub serves
 * each from the session's working directory, so a preview is only as fresh
 * as the file on disk when the timeline renders it.
 */
export function MentionPreviews({ sessionId, mentions }: { sessionId: string; mentions: FileMention[] }) {
  if (mentions.length === 0) return null;
  return (
    <div data-testid="mention-previews" className="flex flex-col gap-2">
      {mentions.map((mention) => (
        <div key={mention.path} data-testid="mention-preview" data-kind={mention.kind} data-path={mention.path}>
          <Preview mention={mention} url={sessionFileUrl(sessionId, mention.path)} />
        </div>
      ))}
    </div>
  );
}
