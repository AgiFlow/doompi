/**
 * The doompiWeb manifest vocabulary: how a package declares its web plugin in
 * package.json, validated and ordered without touching the filesystem. The
 * scan adapter feeds this from real manifests; the sync bundler feeds it from
 * the installed composition's package roots.
 *
 * Plugins are independent: a manifest names no other plugin, and the order
 * plugins install in is only a tiebreak (registrationOrder, then pluginId),
 * because every relation between two plugins resolves by name once all of
 * them are installed. A collision between two packages is a notice for the
 * sync log and the first package keeps the name; only a malformed block is an
 * error, which the scanner turns into a notice for that package alone.
 */

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The order a plugin installs at when its manifest names none. */
export const DEFAULT_REGISTRATION_ORDER = 1000;

export interface WebPluginEntryDeclaration {
  /** Package-relative ./path to the source entry. */
  entry: string;
}

export interface DeclaredWebPlugin {
  pluginId: string;
  registrationOrder: number;
  packageDir: string;
  packageName: string;
  isHost: boolean;
  client: WebPluginEntryDeclaration;
  scopes: readonly ('global' | 'workspace' | 'session')[];
}

export class WebPluginManifestError extends Error {
  constructor(packageDir: string, message: string) {
    super(`doompiWeb manifest in ${packageDir}: ${message}`);
    this.name = 'WebPluginManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEntry(packageDir: string, kind: string, value: unknown): WebPluginEntryDeclaration {
  const raw = typeof value === 'string' ? { entry: value } : value;
  if (!isRecord(raw)) throw new WebPluginManifestError(packageDir, `${kind} must be a path or {entry}.`);
  const { entry } = raw;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) {
    throw new WebPluginManifestError(packageDir, `${kind}.entry must be a package-relative ./path with no '..'.`);
  }
  return { entry };
}

/** The doompiWeb value normalized to a list: one plugin object or an array of them. */
export function pluginBlocksOf(manifest: Record<string, unknown>): unknown[] {
  if (manifest.doompiWeb === undefined) return [];
  return Array.isArray(manifest.doompiWeb) ? manifest.doompiWeb : [manifest.doompiWeb];
}

/** Validates one manifest's blocks into declared plugins; throws WebPluginManifestError on bad shape. */
export function declaredPluginsOf(
  packageDir: string,
  manifest: Record<string, unknown>,
  isHost: boolean,
): DeclaredWebPlugin[] {
  const plugins: DeclaredWebPlugin[] = [];
  for (const block of pluginBlocksOf(manifest)) {
    if (!isRecord(block)) throw new WebPluginManifestError(packageDir, 'each block must be an object.');
    const { pluginId, registrationOrder = DEFAULT_REGISTRATION_ORDER, client, scopes } = block;
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.some((scope) => !['global', 'workspace', 'session'].includes(scope))
    ) {
      throw new WebPluginManifestError(
        packageDir,
        'scopes must explicitly name global, workspace, or session; resync the plugin.',
      );
    }
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new WebPluginManifestError(packageDir, `pluginId '${String(pluginId)}' must be kebab-case.`);
    }
    if (!Number.isInteger(registrationOrder) || (registrationOrder as number) < 0) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' needs a non-negative integer registrationOrder.`);
    }
    plugins.push({
      pluginId,
      registrationOrder: registrationOrder as number,
      packageDir,
      packageName: typeof manifest.name === 'string' ? manifest.name : packageDir,
      isHost,
      client: normalizeEntry(packageDir, 'client', client),
      scopes,
    });
  }
  return plugins;
}

const byInstallOrder = (left: DeclaredWebPlugin, right: DeclaredWebPlugin): number =>
  left.registrationOrder - right.registrationOrder ||
  left.pluginId.localeCompare(right.pluginId) ||
  left.packageDir.localeCompare(right.packageDir);

/**
 * The deterministic install order, (registrationOrder, pluginId), with the
 * cross-package collisions resolved by the browser client registry: the first
 * plugin keeps a shared pluginId and the later package is dropped with a notice.
 */
export function orderDeclaredPlugins(
  plugins: readonly DeclaredWebPlugin[],
  onNotice: (message: string) => void = () => undefined,
): DeclaredWebPlugin[] {
  const sorted = [...plugins].sort(byInstallOrder);
  const byId = new Map<string, DeclaredWebPlugin>();
  const kept: DeclaredWebPlugin[] = [];
  for (const plugin of sorted) {
    const holder = byId.get(plugin.pluginId);
    if (holder !== undefined) {
      onNotice(
        `web plugin '${plugin.pluginId}' from ${plugin.packageDir} is skipped: ${holder.packageDir} already declares it.`,
      );
      continue;
    }
    byId.set(plugin.pluginId, plugin);
    kept.push(plugin);
  }
  return kept;
}
