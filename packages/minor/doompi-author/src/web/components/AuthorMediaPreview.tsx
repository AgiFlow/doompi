import { MediaPreview } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import { authorSessionFileUrl } from '../api/authorFiles';
import { loadAuthorMedia } from '../api/authorMedia';

/** Viewing an attachment does not require enabling authoring or its editing tools. */
export function AuthorMediaPreview({ sessionId, path }: { sessionId: string; path: string }) {
  const source = authorSessionFileUrl(sessionId, path);
  const [loaded, setLoaded] = useState<{ source: string; url?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void loadAuthorMedia(source, controller.signal)
      .then((asset) => {
        if (controller.signal.aborted) {
          asset.dispose();
          return;
        }
        dispose = () => asset.dispose();
        setLoaded({ source, url: asset.url });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({ source, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [source]);
  const current = loaded?.source === source ? loaded : undefined;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {current?.url === undefined ? (
        <p role={current?.error ? 'alert' : 'status'}>{current?.error ?? 'Loading media...'}</p>
      ) : (
        <MediaPreview src={current.url} path={path} data-testid="author-media-preview" />
      )}
    </div>
  );
}
