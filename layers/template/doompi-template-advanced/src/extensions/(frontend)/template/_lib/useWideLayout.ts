import { useCallback, useSyncExternalStore } from 'react';

/** Select one panel mount instead of rendering duplicate desktop and mobile plugin trees. */
export function useWideLayout(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
