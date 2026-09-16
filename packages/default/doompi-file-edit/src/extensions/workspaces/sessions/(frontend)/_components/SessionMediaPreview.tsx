import { MediaPreview } from '@agimon-ai/doompi-web-components';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { useEffect, useState } from 'react';

/** Media elements cannot issue the encrypted fetch required by remote session files. */
export function SessionMediaPreview({
  src,
  path,
  'data-testid': testId,
}: {
  src: string;
  path: string;
  'data-testid'?: string;
}) {
  const [loaded, setLoaded] = useState<{ source: string; url?: string; error?: string }>();
  useEffect(() => {
    if (src === '') return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      const response = await sealedTransport.fetch(src, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Media could not be loaded (${response.status}).`);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setLoaded({ source: src, url });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setLoaded({ source: src, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      controller.abort();
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [src]);
  const current = loaded?.source === src ? loaded : undefined;
  if (current?.url === undefined)
    return <p role={current?.error ? 'alert' : 'status'}>{current?.error ?? 'Loading media...'}</p>;
  return <MediaPreview src={current.url} path={path} data-testid={testId} />;
}
