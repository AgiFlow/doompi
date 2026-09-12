import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  findPluginManifestPath,
  type GitPluginSource,
  isRemotePluginSource,
  type NpmPluginSource,
  type PluginEntry,
  type PluginManifestMetadata,
  type PluginSkillDiscovery,
} from '@agimon-ai/doompi-config/domains';

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const INSTALL_MARKER = '.doompi-plugin.json';
const INSTALL_MARKER_VERSION = 1;
const OUTPUT_LIMIT = 64 * 1024;

interface CommandOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

interface InstallMarker {
  version: number;
  source: GitPluginSource | NpmPluginSource;
}

interface InspectedPluginManifest {
  skillDiscovery: PluginSkillDiscovery;
  manifest: PluginManifestMetadata;
}

export interface PluginSourceMaterializers {
  git: (source: GitPluginSource, workspace: string) => Promise<string>;
  npm: (source: NpmPluginSource, workspace: string) => Promise<string>;
}

export interface PluginMaterializerOptions {
  materializers?: Partial<PluginSourceMaterializers>;
}

function appendOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT);
}

function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once('error', (error) => {
      reject(new Error(`Failed to run ${command}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      const details = stderr.trim() || stdout.trim();
      reject(new Error(`${command} ${args.join(' ')} failed with ${outcome}${details ? `\n${details}` : ''}`));
    });
  });
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`${label} resolves outside ${root}`);
}

async function materializeGitSource(source: GitPluginSource, workspace: string): Promise<string> {
  const checkout = path.join(workspace, 'checkout');
  const pluginRoot = source.path ? path.resolve(checkout, source.path) : checkout;
  if (source.path) assertContained(checkout, pluginRoot, 'Git plugin path');
  const cloneArgs = ['clone', '--filter=blob:none'];
  if (source.path) cloneArgs.push('--sparse', '--no-checkout');
  cloneArgs.push(source.url, checkout);
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  await runCommand('git', cloneArgs, { environment });

  if (source.path) {
    await runCommand('git', ['sparse-checkout', 'set', '--no-cone', '--', source.path], {
      cwd: checkout,
      environment,
    });
  }
  if (source.sha) {
    await runCommand('git', ['checkout', source.sha], { cwd: checkout, environment });
    const checkedOutSha = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: checkout, environment });
    if (checkedOutSha.toLowerCase() !== source.sha.toLowerCase()) {
      throw new Error(`Checked out Git SHA ${checkedOutSha} does not match requested SHA ${source.sha}`);
    }
  } else if (source.ref) {
    await runCommand('git', ['checkout', source.ref], { cwd: checkout, environment });
  } else if (source.path) {
    await runCommand('git', ['checkout'], { cwd: checkout, environment });
  }

  return pluginRoot;
}

async function materializeNpmSource(source: NpmPluginSource, workspace: string): Promise<string> {
  const prefix = path.join(workspace, 'npm');
  const packageSpecifier = source.version ? `${source.package}@${source.version}` : source.package;
  const args = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--prefix',
    prefix,
    packageSpecifier,
  ];
  if (source.registry) args.push('--registry', source.registry);
  await runCommand('npm', args, {
    environment: {
      ...process.env,
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
  });
  const pluginRoot = path.resolve(prefix, 'node_modules', ...source.package.split('/'));
  assertContained(path.join(prefix, 'node_modules'), pluginRoot, 'npm plugin package');
  return pluginRoot;
}

const DEFAULT_MATERIALIZERS: PluginSourceMaterializers = {
  git: materializeGitSource,
  npm: materializeNpmSource,
};

async function pathType(target: string): Promise<'directory' | 'missing' | 'other'> {
  try {
    const stat = await fs.promises.lstat(target);
    return stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function optionalManifestString(manifest: Record<string, unknown>, key: string): string | undefined {
  const value = manifest[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validatePluginManifest(pluginRoot: string, manifestPath: string): InspectedPluginManifest {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      throw new Error('manifest must contain a JSON object');
    }
    const record = manifest as Record<string, unknown>;
    const agentPluginSchema =
      manifestPath === path.join(pluginRoot, 'plugin.json') && record.$schema === AGENT_PLUGIN_SCHEMA
        ? AGENT_PLUGIN_SCHEMA
        : undefined;
    const name = optionalManifestString(record, 'name');
    const version = optionalManifestString(record, 'version');
    const description = optionalManifestString(record, 'description');
    return {
      skillDiscovery: agentPluginSchema ? 'direct-children' : 'recursive',
      manifest: {
        path: manifestPath,
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        ...(agentPluginSchema ? { agentPluginSchema } : {}),
      },
    };
  } catch (error) {
    throw new Error(
      `Invalid plugin manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function inspectInstallation(entry: PluginEntry): Promise<InspectedPluginManifest | false> {
  const type = await pathType(entry.directory);
  if (type === 'missing') return false;
  if (type !== 'directory') throw new Error(`Remote plugin cache path is not a directory: ${entry.directory}`);
  if (!entry.source || !isRemotePluginSource(entry.source)) {
    throw new Error(`Remote plugin entry is missing its source: ${entry.name ?? entry.directory}`);
  }

  let marker: InstallMarker;
  try {
    marker = JSON.parse(
      await fs.promises.readFile(path.join(entry.directory, INSTALL_MARKER), 'utf8'),
    ) as InstallMarker;
  } catch (error) {
    throw new Error(`Remote plugin cache is not managed by DoomPi: ${entry.directory}`, { cause: error });
  }
  if (marker.version !== INSTALL_MARKER_VERSION || JSON.stringify(marker.source) !== JSON.stringify(entry.source)) {
    throw new Error(`Remote plugin cache metadata does not match ${entry.name ?? entry.directory}: ${entry.directory}`);
  }
  const manifestPath = findPluginManifestPath(entry.directory);
  if (!manifestPath) {
    throw new Error(`Remote plugin cache is missing a supported plugin manifest: ${entry.directory}`);
  }
  return validatePluginManifest(entry.directory, manifestPath);
}

async function copyPluginSource(sourceRoot: string, destination: string): Promise<void> {
  if ((await pathType(sourceRoot)) !== 'directory') {
    throw new Error(`Materialized plugin source is not a directory: ${sourceRoot}`);
  }
  await fs.promises.cp(sourceRoot, destination, {
    recursive: true,
    filter: (candidate) => path.basename(candidate) !== '.git',
  });
}

function isRenameRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

async function installRemotePlugin(entry: PluginEntry, materializers: PluginSourceMaterializers): Promise<PluginEntry> {
  if (!entry.source || !isRemotePluginSource(entry.source)) return entry;
  const existingManifest = await inspectInstallation(entry);
  if (existingManifest) return { ...entry, ...existingManifest };

  const parent = path.dirname(entry.directory);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await pathType(parent)) !== 'directory') {
    throw new Error(`Remote plugin cache root is not a directory: ${parent}`);
  }
  await fs.promises.chmod(parent, 0o700);
  const workspace = await fs.promises.mkdtemp(path.join(parent, '.plugin-staging-'));
  const installation = path.join(workspace, 'installation');
  try {
    const sourceRoot =
      entry.source.type === 'git'
        ? await materializers.git(entry.source, workspace)
        : await materializers.npm(entry.source, workspace);
    await copyPluginSource(sourceRoot, installation);
    const manifestPath = findPluginManifestPath(installation);
    if (!manifestPath) {
      throw new Error(`Remote plugin ${entry.name ?? entry.directory} does not contain a supported plugin manifest`);
    }
    validatePluginManifest(installation, manifestPath);
    const markerPath = path.join(installation, INSTALL_MARKER);
    if ((await pathType(markerPath)) !== 'missing') {
      throw new Error(`Remote plugin contains reserved cache metadata path: ${INSTALL_MARKER}`);
    }
    const marker: InstallMarker = { version: INSTALL_MARKER_VERSION, source: entry.source };
    await fs.promises.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await fs.promises.rename(installation, entry.directory);
    } catch (error) {
      if (!isRenameRace(error)) throw error;
      await fs.promises.rm(installation, { recursive: true, force: true });
      const racedManifest = await inspectInstallation(entry);
      if (!racedManifest) throw new Error(`Remote plugin installation race left no cache: ${entry.directory}`);
      return { ...entry, ...racedManifest };
    }
    const installedManifest = await inspectInstallation(entry);
    if (!installedManifest) throw new Error(`Remote plugin installation left no cache: ${entry.directory}`);
    return { ...entry, ...installedManifest };
  } catch (error) {
    throw new Error(
      `Failed to install remote plugin ${entry.name ?? entry.directory}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

/** Downloads selected remote plugins once into their content-addressed cache directories. */
export async function materializePluginEntries(
  entries: readonly PluginEntry[],
  options: PluginMaterializerOptions = {},
): Promise<PluginEntry[]> {
  const materializers: PluginSourceMaterializers = {
    git: options.materializers?.git ?? DEFAULT_MATERIALIZERS.git,
    npm: options.materializers?.npm ?? DEFAULT_MATERIALIZERS.npm,
  };
  return Promise.all(entries.map((entry) => installRemotePlugin(entry, materializers)));
}
