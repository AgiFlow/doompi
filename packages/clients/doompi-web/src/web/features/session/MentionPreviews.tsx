import { Badge, FileIcon } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import type { FileMention } from '../../lib/fileMentions.ts';
import { loadSessionAsset, type SessionAsset } from '../../lib/sessionAsset.ts';

function downloadName(filePath: string): string {
  return filePath.split('/').at(-1) || 'download';
}

export function MentionPreviewAsset({ mention, asset }: { mention: FileMention; asset: SessionAsset }) {
  if (mention.kind === 'image') {
    const image = (
      <img src={asset.url} alt={mention.path} className="max-h-[360px] max-w-full rounded border border-doom-border" />
    );
    if (asset.contentType !== 'image/svg+xml') {
      return (
        <a href={asset.url} target="_blank" rel="noreferrer">
          {image}
        </a>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1">
        {image}
        <Badge asChild size="md" className="bg-doom-panel text-doom-text hover:border-doom-blue/50">
          <a href={asset.url} download={downloadName(mention.path)}>
            <FileIcon className="h-3 w-3 shrink-0 text-doom-faint" />
            Download {downloadName(mention.path)}
          </a>
        </Badge>
      </div>
    );
  }
  if (mention.kind === 'video') {
    return (
      <video
        src={asset.url}
        controls
        preload="metadata"
        className="max-h-[360px] max-w-full rounded border border-doom-border"
      />
    );
  }
  if (mention.kind === 'pdf') {
    return (
      <iframe
        src={asset.url}
        title={mention.path}
        sandbox=""
        className="h-[480px] w-full rounded border border-doom-border bg-doom-deep"
      />
    );
  }
  return (
    <Badge asChild size="md" className="self-start bg-doom-panel text-doom-text hover:border-doom-blue/50">
      <a href={asset.url} download={downloadName(mention.path)}>
        <FileIcon className="h-3 w-3 shrink-0 text-doom-faint" />
        {mention.path}
      </a>
    </Badge>
  );
}

function MentionPreview({ sessionId, mention }: { sessionId: string; mention: FileMention }) {
  const [asset, setAsset] = useState<SessionAsset | null>();
  useEffect(() => {
    let active = true;
    let held: SessionAsset | undefined;
    setAsset(undefined);
    void loadSessionAsset(sessionId, mention.path)
      .then((loaded) => {
        if (!active) {
          loaded.dispose();
          return;
        }
        held = loaded;
        setAsset(loaded);
      })
      .catch(() => {
        if (active) setAsset(null);
      });
    return () => {
      active = false;
      held?.dispose();
    };
  }, [mention.path, sessionId]);

  if (asset) return <MentionPreviewAsset mention={mention} asset={asset} />;
  return (
    <Badge size="md" className="self-start bg-doom-panel text-doom-faint">
      <FileIcon className="h-3 w-3 shrink-0" />
      {asset === null ? `Could not load ${mention.path}` : mention.path}
    </Badge>
  );
}

/** The cwd-scoped files mentioned by a message, fetched through the sealed HTTP channel. */
export function MentionPreviews({ sessionId, mentions }: { sessionId: string; mentions: FileMention[] }) {
  if (mentions.length === 0) return null;
  return (
    <div data-testid="mention-previews" className="flex flex-col gap-2">
      {mentions.map((mention) => (
        <div key={mention.path} data-testid="mention-preview" data-kind={mention.kind} data-path={mention.path}>
          <MentionPreview sessionId={sessionId} mention={mention} />
        </div>
      ))}
    </div>
  );
}
