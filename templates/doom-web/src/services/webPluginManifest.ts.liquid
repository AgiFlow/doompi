/**
 * The doompiWeb manifest vocabulary: how a package declares its web plugin in
 * package.json, validated and ordered without touching the filesystem. The
 * scan adapter feeds this from real manifests; the sync bundler feeds it from
 * the installed composition's package roots.
 */

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface WebPluginEntryDeclaration {
  /** Package-relative ./path to the source entry. */
  entry: string;
  /** Package-relative ./path to the built hub entry; required for non-host hub blocks. */
  dist?: string;
}

export interface DeclaredWebPlugin {
  pluginId: string;
  registrationOrder: number;
  dependencies: string[];
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
    const { pluginId, registrationOrder, dependencies = [], channels = [], client, hub } = block;
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new WebPluginManifestError(packageDir, `pluginId '${String(pluginId)}' must be kebab-case.`);
    }
    if (!Number.isInteger(registrationOrder) || (registrationOrder as number) < 0) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' needs a non-negative integer registrationOrder.`);
    }
    if (!Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== 'string')) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' dependencies must be pluginId strings.`);
    }
    if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string' || channel === '')) {
      throw new WebPluginManifestError(packageDir, `'${pluginId}' channels must be non-empty strings.`);
    }
    plugins.push({
      pluginId,
      registrationOrder: registrationOrder as number,
      dependencies: dependencies as string[],
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

/**
 * Cross-package validation and deterministic order: unique ids, orders, and
 * channels (wire frame types are a global namespace), then a topological sort
 * by dependencies with registrationOrder and pluginId as tiebreaks.
 */
export function orderDeclaredPlugins(plugins: readonly DeclaredWebPlugin[]): DeclaredWebPlugin[] {
  const byId = new Map<string, DeclaredWebPlugin>();
  const orders = new Map<number, string>();
  const seenChannels = new Map<string, string>();
  for (const plugin of plugins) {
    if (byId.has(plugin.pluginId)) {
      throw new WebPluginManifestError(plugin.packageDir, `duplicate pluginId '${plugin.pluginId}'.`);
    }
    byId.set(plugin.pluginId, plugin);
    const holder = orders.get(plugin.registrationOrder);
    if (holder !== undefined) {
      throw new WebPluginManifestError(
        plugin.packageDir,
        `registrationOrder ${String(plugin.registrationOrder)} is already used by '${holder}'.`,
      );
    }
    orders.set(plugin.registrationOrder, plugin.pluginId);
    for (const channel of plugin.channels) {
      const owner = seenChannels.get(channel);
      if (owner !== undefined) {
        throw new WebPluginManifestError(
          plugin.packageDir,
          `channel '${channel}' is already claimed by '${owner}'; wire frame types are global.`,
        );
      }
      seenChannels.set(channel, plugin.pluginId);
    }
  }
  for (const plugin of plugins) {
    for (const dep of plugin.dependencies) {
      if (!byId.has(dep)) {
        throw new WebPluginManifestError(plugin.packageDir, `'${plugin.pluginId}' depends on unknown plugin '${dep}'.`);
      }
    }
  }

  const sorted: DeclaredWebPlugin[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byPriority = (left: DeclaredWebPlugin, right: DeclaredWebPlugin): number =>
    left.registrationOrder - right.registrationOrder || left.pluginId.localeCompare(right.pluginId);
  const visit = (plugin: DeclaredWebPlugin, trail: string[]): void => {
    const mark = state.get(plugin.pluginId);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`doompiWeb dependency cycle: ${[...trail, plugin.pluginId].join(' -> ')}`);
    }
    state.set(plugin.pluginId, 'visiting');
    const deps = plugin.dependencies
      .map((dep) => byId.get(dep))
      .filter((dep): dep is DeclaredWebPlugin => dep !== undefined)
      .sort(byPriority);
    for (const dep of deps) visit(dep, [...trail, plugin.pluginId]);
    state.set(plugin.pluginId, 'done');
    sorted.push(plugin);
  };
  for (const plugin of [...plugins].sort(byPriority)) visit(plugin, []);
  return sorted;
}
