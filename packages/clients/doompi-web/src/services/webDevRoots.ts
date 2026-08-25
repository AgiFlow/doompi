/**
 * Where the cockpit's dev server finds the plugin packages to serve with hot
 * reload. Pure: the adapter hands in the environment value and the roots file
 * the last `doompi sync` wrote next to its bundle; this only decides.
 */

/** A delimiter-separated list of plugin package roots; wins over the synced roots file. */
export const PLUGIN_ROOTS_ENV = 'DOOMPI_WEB_PLUGIN_ROOTS';
/** The file `doompi sync` writes beside its bundle, listing the package roots it bundled. */
export const PLUGIN_ROOTS_FILE = 'pluginRoots.json';

export interface DevPluginRootsInput {
  /** The raw environment value, undefined when unset. */
  envValue: string | undefined;
  /** The roots file's text, undefined when no synced bundle exists. */
  rootsFileText: string | undefined;
  /** The platform's path list delimiter (':' on POSIX, ';' on Windows). */
  delimiter: string;
}

/** The plugin roots the dev server should serve: the environment list, else the synced list, else none. */
export function devPluginRoots({ envValue, rootsFileText, delimiter }: DevPluginRootsInput): string[] {
  if (envValue !== undefined && envValue.trim() !== '') {
    return envValue
      .split(delimiter)
      .map((root) => root.trim())
      .filter((root) => root !== '');
  }
  if (rootsFileText === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(rootsFileText);
    return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === 'string') : [];
  } catch {
    return [];
  }
}
