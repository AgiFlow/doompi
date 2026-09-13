import { sessionFileUrl } from '../../types/media.ts';
import { sealedHttpSession } from './sealedSession.ts';

export interface SessionAsset {
  url: string;
  contentType: string;
  dispose(): void;
}

/** Fetches one cwd-scoped file through the sealed HTTP channel and owns its short-lived browser URL. */
export async function loadSessionAsset(sessionId: string, relativePath: string): Promise<SessionAsset> {
  const response = await sealedHttpSession.fetch(sessionFileUrl(sessionId, relativePath), {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`The session file could not be loaded (${String(response.status)}).`);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  let disposed = false;
  return {
    url,
    contentType: (response.headers.get('content-type') ?? blob.type).split(';', 1)[0]?.toLowerCase() ?? '',
    dispose() {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(url);
    },
  };
}
