// Discovery for DoomPi web plugins, modeled on boomlink's first-party plugin
// scanner: packages declare a `doompiWeb` block (one plugin object or an
// array of them) in package.json; this module finds, validates, and orders
// them deterministically for the generators.
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
const PACKAGE_GLOB_PARENTS = ['packages', 'layers'];
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function findWorkspaceRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_MANIFEST))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function fail(packageDir, message) {
  throw new Error(`doompiWeb manifest in ${packageDir}: ${message}`);
}

function normalizeEntry(packageDir, isHost, kind, value) {
  const raw = typeof value === 'string' ? { entry: value } : value;
  if (typeof raw !== 'object' || raw === null) fail(packageDir, `${kind} must be a path or {entry, specifier}.`);
  const { entry, specifier } = raw;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) {
    fail(packageDir, `${kind}.entry must be a package-relative ./path with no '..'.`);
  }
  if (!fs.existsSync(path.join(packageDir, entry))) fail(packageDir, `${kind}.entry '${entry}' does not exist.`);
  if (isHost) {
    if (specifier !== undefined) fail(packageDir, `${kind}.specifier is not allowed on the host package.`);
    return { entry };
  }
  if (typeof specifier !== 'string' || specifier === '') {
    fail(packageDir, `${kind}.specifier is required for a non-host package.`);
  }
  return { entry, specifier };
}

function pluginBlocks(manifest) {
  if (manifest.doompiWeb === undefined) return [];
  return Array.isArray(manifest.doompiWeb) ? manifest.doompiWeb : [manifest.doompiWeb];
}

/**
 * Scans the workspace for doompiWeb plugin declarations.
 *
 * hostDir is the package running the generators; its entries are emitted as
 * relative imports, every other package's through its published specifier.
 * Returns plugins topologically sorted by dependencies, registrationOrder as
 * the tiebreak, pluginId as the final tiebreak.
 */
export function scanWebPlugins(hostDir) {
  const workspaceRoot = findWorkspaceRoot(hostDir);
  const packageDirs = new Set([hostDir]);
  if (workspaceRoot !== undefined) {
    for (const parent of PACKAGE_GLOB_PARENTS) {
      const parentDir = path.join(workspaceRoot, parent);
      let groups = [];
      try {
        groups = fs.readdirSync(parentDir);
      } catch {
        continue;
      }
      for (const group of groups) {
        const groupDir = path.join(parentDir, group);
        let names = [];
        try {
          names = fs.readdirSync(groupDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (fs.existsSync(path.join(groupDir, name, 'package.json'))) packageDirs.add(path.join(groupDir, name));
        }
      }
    }
  }

  const plugins = [];
  for (const packageDir of [...packageDirs].sort((a, b) => a.localeCompare(b))) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const isHost = path.resolve(packageDir) === path.resolve(hostDir);
    for (const block of pluginBlocks(manifest)) {
      if (typeof block !== 'object' || block === null) fail(packageDir, 'each block must be an object.');
      const { pluginId, registrationOrder, dependencies = [], channels = [], client, hub } = block;
      if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
        fail(packageDir, `pluginId '${String(pluginId)}' must be kebab-case.`);
      }
      if (!Number.isInteger(registrationOrder) || registrationOrder < 0) {
        fail(packageDir, `'${pluginId}' needs a non-negative integer registrationOrder.`);
      }
      if (!Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== 'string')) {
        fail(packageDir, `'${pluginId}' dependencies must be pluginId strings.`);
      }
      if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string' || channel === '')) {
        fail(packageDir, `'${pluginId}' channels must be non-empty strings.`);
      }
      plugins.push({
        pluginId,
        registrationOrder,
        dependencies,
        channels,
        packageDir,
        packageName: manifest.name,
        isHost,
        client: normalizeEntry(packageDir, isHost, 'client', client),
        hub: hub === undefined ? undefined : normalizeEntry(packageDir, isHost, 'hub', hub),
      });
    }
  }

  const byId = new Map();
  const orders = new Map();
  const seenChannels = new Map();
  for (const plugin of plugins) {
    if (byId.has(plugin.pluginId)) fail(plugin.packageDir, `duplicate pluginId '${plugin.pluginId}'.`);
    byId.set(plugin.pluginId, plugin);
    if (orders.has(plugin.registrationOrder)) {
      fail(
        plugin.packageDir,
        `registrationOrder ${plugin.registrationOrder} is already used by '${orders.get(plugin.registrationOrder)}'.`,
      );
    }
    orders.set(plugin.registrationOrder, plugin.pluginId);
    for (const channel of plugin.channels) {
      if (seenChannels.has(channel)) {
        fail(
          plugin.packageDir,
          `channel '${channel}' is already claimed by '${seenChannels.get(channel)}'; wire frame types are global.`,
        );
      }
      seenChannels.set(channel, plugin.pluginId);
    }
  }
  for (const plugin of plugins) {
    for (const dep of plugin.dependencies) {
      if (!byId.has(dep)) fail(plugin.packageDir, `'${plugin.pluginId}' depends on unknown plugin '${dep}'.`);
    }
  }

  // Topological order, boomlink-style: dependencies first, registrationOrder
  // then pluginId as tiebreaks, cycles rejected.
  const sorted = [];
  const state = new Map();
  const visit = (plugin, trail) => {
    const mark = state.get(plugin.pluginId);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`doompiWeb dependency cycle: ${[...trail, plugin.pluginId].join(' -> ')}`);
    }
    state.set(plugin.pluginId, 'visiting');
    const deps = plugin.dependencies
      .map((dep) => byId.get(dep))
      .sort((a, b) => a.registrationOrder - b.registrationOrder || a.pluginId.localeCompare(b.pluginId));
    for (const dep of deps) visit(dep, [...trail, plugin.pluginId]);
    state.set(plugin.pluginId, 'done');
    sorted.push(plugin);
  };
  for (const plugin of [...plugins].sort(
    (a, b) => a.registrationOrder - b.registrationOrder || a.pluginId.localeCompare(b.pluginId),
  )) {
    visit(plugin, []);
  }
  return sorted;
}
