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
  /** Package-relative ./path to the built hub entry; required for non-host hub blocks. */
  dist?: string;
}

export interface DeclaredWebPlugin {
  pluginId: string;
  registrationOrder: number;
  channels: string[];
  packageDir: string;
  packageName: string;
  isHost: boolean;
  client: WebPluginEntryDeclaration;
  hub?: WebPluginEntryDeclaration;
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

function normalizeEntry(packageDir: string, isHost: boolean, kind: string, value: unknown): WebPluginEntryDeclaration {
  const raw = typeof value === 'string' ? { entry: value } : value;
  if (!isRecord(raw)) throw new WebPluginManifestError(packageDir, `${kind} must be a path or {entry, dist}.`);
  const { entry, dist } = raw;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) {
    throw new WebPluginManifestError(packageDir, `${kind}.entry must be a package-relative ./path with no '..'.`);
  }
  if (dist !== undefined && (typeof dist !== 'string' || !dist.startsWith('./') || dist.includes('..'))) {
    throw new WebPluginManifestError(packageDir, `${kind}.dist must be a package-relative ./path with no '..'.`);
  }
  if (kind === 'hub' && !isHost && typeof dist !== 'string') {
    throw new WebPluginManifestError(
      packageDir,
      'hub.dist is required for a non-host package: the hub imports the built entry the package ships.',
    );
  }
  return { entry, ...(typeof dist === 'string' ? { dist } : {}) };
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
    const { pluginId, registrationOrder = DEFAULT_REGISTRATION_ORDER, channels = [], client, hub } = block;
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new WebPluginManifestError(packageDir, `pluginId '${String(pluginId)}' must be kebab-case.`);
    }
    if (!Number.isInteger(registrationOrder) || (registrationOrder as number) < 0) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' needs a non-negative integer registrationOrder.`);
    }
    if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string' || channel === '')) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' channels must be non-empty strings.`);
    }
    plugins.push({
      pluginId,
      registrationOrder: registrationOrder as number,
      channels: channels as string[],
      packageDir,
      packageName: typeof manifest.name === 'string' ? manifest.name : packageDir,
      isHost,
      client: normalizeEntry(packageDir, isHost, 'client', client),
      ...(hub === undefined ? {} : { hub: normalizeEntry(packageDir, isHost, 'hub', hub) }),
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
 * cross-package collisions resolved the way the client registry resolves
 * them: the first plugin keeps a shared pluginId and the later package is
 * dropped with a notice; a channel two kept plugins both declare is noticed
 * here and settled first-wins by the client and the hub loader.
 */
export function orderDeclaredPlugins(
  plugins: readonly DeclaredWebPlugin[],
  onNotice: (message: string) => void = () => undefined,
): DeclaredWebPlugin[] {
  const sorted = [...plugins].sort(byInstallOrder);
  const byId = new Map<string, DeclaredWebPlugin>();
  const channelOwners = new Map<string, string>();
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
    for (const channel of plugin.channels) {
      const owner = channelOwners.get(channel);
      if (owner !== undefined) {
        onNotice(
          `web plugin '${plugin.pluginId}' channel '${channel}' is already claimed by '${owner}'; the first keeps it.`,
        );
        continue;
      }
      channelOwners.set(channel, plugin.pluginId);
    }
  }
  return kept;
}
