import { sessionApiPath } from '@agimon-ai/doompi-core/web';

import { sessionFileUrl } from '../../types/media';
import { sealedHttpSession } from './sealedSession';

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

export interface StoredSessionAttachment {
  path: string;
  mimeType: string;
  size: number;
}

/** Stores one composer file on the host through the sealed HTTP channel, so a tool can be handed its path. */
export async function uploadSessionAttachment(sessionId: string, file: File): Promise<StoredSessionAttachment> {
  const response = await sealedHttpSession.fetch(
    `${sessionApiPath(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
    },
  );
  if (!response.ok) throw new Error(`The attachment could not be uploaded (${String(response.status)}).`);
  const { path, mimeType, size } = (await response.json()) as StoredSessionAttachment;
  return { path, mimeType, size };
}
