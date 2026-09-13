const RELOAD_ATTEMPTED_KEY = 'doompi:stale-chunk-reload-attempted';
const DYNAMIC_IMPORT_FAILURE = 'Failed to fetch dynamically imported module';

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface RecoveryOptions {
  target?: EventTarget;
  storage?: RecoveryStorage;
  reload?: () => void;
}

function isStaleChunkFailure(event: Event): boolean {
  if (!('payload' in event)) return false;
  const payload = event.payload;
  return payload instanceof Error && payload.message.startsWith(DYNAMIC_IMPORT_FAILURE);
}

/** Reloads once when a deployed Vite build invalidates a lazy chunk held by an open tab. */
export function installStaleChunkRecovery(options: RecoveryOptions = {}): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());

  const onPreloadError = (event: Event) => {
    if (!isStaleChunkFailure(event)) return;

    try {
      if (storage.getItem(RELOAD_ATTEMPTED_KEY)) return;
      storage.setItem(RELOAD_ATTEMPTED_KEY, '1');
    } catch {
      return;
    }

    event.preventDefault();
    reload();
  };

  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}
