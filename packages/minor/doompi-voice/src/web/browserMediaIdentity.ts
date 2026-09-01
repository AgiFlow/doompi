const CLIENT_ID_STORAGE_KEY = 'doompi.voice-media.client-id';

type ClientIdStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A tab keeps its media identity across reloads while each runtime still gets its own lease. */
export function browserVoiceMediaClientId(storage: ClientIdStorage, createId: () => string): string {
  try {
    const stored = storage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored) return stored;
    const clientId = `browser-${createId()}`;
    storage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    return clientId;
  } catch {
    return `browser-${createId()}`;
  }
}
