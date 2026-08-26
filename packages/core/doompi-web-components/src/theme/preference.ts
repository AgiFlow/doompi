/** Where the page remembers the chosen theme; one key, machine-local. */
export const THEME_STORAGE_KEY = 'doompi.web.theme';

/** The two Storage calls the preference needs, so tests pass a plain map. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The stored theme name, or null when nothing was chosen or storage is unavailable. */
export function readThemePreference(storage: PreferenceStorage | undefined): string | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

/** Remembers a theme name; null forgets it. Storage failures are swallowed: a theme is a convenience. */
export function writeThemePreference(storage: PreferenceStorage | undefined, name: string | null): void {
  try {
    if (name === null) storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, name);
  } catch {
    // Private mode or a full quota: the theme still applies for this page load.
  }
}
