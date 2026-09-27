import { sessionApiPath } from '@agimon-ai/doompi-core/web';

import { sealedHttpSession } from './sealedSession';

/**
 * Fetches a session's profile avatar through the sealed HTTP channel and returns
 * a browser object URL for it. A plain image URL cannot carry the sealed
 * transport's authentication, so the image is loaded here and handed over ready.
 * The caller owns the URL and revokes it once no card shows it.
 */
export async function loadSessionAvatar(sessionId: string, iconVersion: string): Promise<string> {
  const response = await sealedHttpSession.fetch(
    `${sessionApiPath(sessionId)}/avatar?v=${encodeURIComponent(iconVersion)}`,
    { credentials: 'same-origin' },
  );
  if (!response.ok) throw new Error(`The session avatar could not be loaded (${String(response.status)}).`);
  return URL.createObjectURL(await response.blob());
}
