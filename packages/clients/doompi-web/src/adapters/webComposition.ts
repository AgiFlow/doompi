import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSyncRegistration, type SyncRegistration } from '@agimon-ai/doompi/services';
import { PLUGIN_ROOTS_FILE } from '../services/webDevRoots.ts';
import { bundleCockpitWeb, type BundleCockpitWebOptions } from './webBundler.ts';
import { SERVER_REGISTRY_FILE } from './webPluginGenerate.ts';

const INDEX_FILE = 'index.html';
const COMPOSITIONS_DIRECTORY = 'compositions';
const COMPOSITION_CACHE_VERSION = 4;
export interface ResolvedWebComposition {
  /** The synchronized repositories represented in this cockpit bundle. */
  repositoryRoots: readonly string[];
  /** The built SPA directory. */
  webDirectory: string;
  /**
   * The composition's own generated hub API routes, when one composition is
   * served directly. A union bundle has none: server routes are imported at
   * runtime, not bundled, so each repository's hub surface stays its own
   * mount table and the hub loads them per root instead of merging them.
   */
  apiDirectory?: string;
}

export interface ResolveWebCompositionOptions {
  /** Canonical repository roots belonging to the live sessions, or the one pinned repository. */
  repositoryRoots: readonly string[];
  /** Machine-local cockpit state directory. Union bundles are cached below it. */
  stateDirectory: string;
  onNotice?: (message: string) => void;
  /** Test seam over registration discovery. */
  readRegistration?: (repositoryRoot: string) => SyncRegistration | undefined;
  /** Test seam over Vite's bundle build. */
  bundle?: (options: BundleCockpitWebOptions) => Promise<{ assetsDir: string; pluginIds: string[] }>;
}

interface RegisteredComposition {
  registration: SyncRegistration;
  pluginRoots: string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function packageRootOf(entryPath: string): string | undefined {
  let directory = path.dirname(path.resolve(entryPath));
  for (;;) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function rootsFromState(registration: SyncRegistration, notice: (message: string) => void): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registration.statePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the sync state is not an object');
    }
    const resolved = (parsed as Record<string, unknown>).resolved;
    if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
      throw new Error('the sync state has no resolved entries');
    }
    return uniqueSorted(
      Object.values(resolved as Record<string, unknown>)
        .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
        .map(packageRootOf)
        .filter((root): root is string => root !== undefined),
    );
  } catch (error) {
    notice(
      `repository ${registration.root} has unreadable synchronized package roots (${describeError(error)}); it is skipped`,
    );
    return undefined;
  }
}

function readPluginRoots(registration: SyncRegistration, notice: (message: string) => void): string[] | undefined {
  if (registration.webDirectory !== null && fs.existsSync(path.join(registration.webDirectory, INDEX_FILE))) {
    const rootsPath = path.join(path.dirname(registration.webDirectory), PLUGIN_ROOTS_FILE);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(rootsPath, 'utf8'));
      if (!Array.isArray(parsed) || parsed.some((root) => typeof root !== 'string' || root === '')) {
        throw new Error('the roots file is not an array of paths');
      }
      return uniqueSorted(parsed as string[]);
    } catch (error) {
      notice(
        `repository ${registration.root} has unreadable cockpit roots (${describeError(error)}); using its sync state`,
      );
    }
  }
  return rootsFromState(registration, notice);
}

function readCompositions(options: ResolveWebCompositionOptions): RegisteredComposition[] {
  const notice = options.onNotice ?? ((): void => {});
  const readRegistration = options.readRegistration ?? ((root: string) => readSyncRegistration(root));
  const registrations: RegisteredComposition[] = [];
  for (const repositoryRoot of uniqueSorted(options.repositoryRoots)) {
    let registration: SyncRegistration | undefined;
    try {
      registration = readRegistration(repositoryRoot);
    } catch (error) {
      notice(
        `repository ${repositoryRoot} has an unreadable sync registration (${describeError(error)}); it is skipped`,
      );
      continue;
    }
    if (registration === undefined) {
      notice(`repository ${repositoryRoot} has no sync registration; run doompi sync there to add its cockpit plugins`);
      continue;
    }
    const pluginRoots = readPluginRoots(registration, notice);
    if (pluginRoots !== undefined) registrations.push({ registration, pluginRoots });
  }
  return registrations;
}

function fingerprint(compositions: readonly RegisteredComposition[], pluginRoots: readonly string[]): string {
  const registrations = compositions.map(({ registration }) => ({
    root: registration.root,
    generation: registration.generation,
    stateSha256: registration.stateSha256,
    webDirectory: registration.webDirectory,
    apiDirectory: registration.apiDirectory,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ cacheVersion: COMPOSITION_CACHE_VERSION, registrations, pluginRoots }))
    .digest('hex')
    .slice(0, 32);
}

function cachedComposition(directory: string): ResolvedWebComposition | undefined {
  const webDirectory = path.join(directory, 'web');
  if (
    !fs.existsSync(path.join(webDirectory, INDEX_FILE)) ||
    !fs.existsSync(path.join(directory, SERVER_REGISTRY_FILE))
  ) {
    return undefined;
  }
  return { repositoryRoots: [], webDirectory };
}

/**
 * Resolves the cockpit bundle independently from the directory that launched the hub.
 *
 * One synchronized composition is served directly. Several live compositions first
 * reuse an existing superset when one already contains every package root. Only a
 * genuinely new union invokes Vite, and that result is cached by immutable sync
 * generation under the cockpit's machine-local state directory.
 */
export async function resolveWebComposition(
  options: ResolveWebCompositionOptions,
): Promise<ResolvedWebComposition | undefined> {
  const notice = options.onNotice ?? ((): void => {});
  const compositions = readCompositions(options);
  if (compositions.length === 0) return undefined;

  const repositoryRoots = uniqueSorted(compositions.map(({ registration }) => registration.root));
  const pluginRoots = uniqueSorted(compositions.flatMap((composition) => composition.pluginRoots));
  const existing = compositions.find(
    (composition) =>
      sameValues(composition.pluginRoots, pluginRoots) &&
      composition.registration.webDirectory !== null &&
      fs.existsSync(path.join(composition.registration.webDirectory, INDEX_FILE)),
  );
  if (existing !== undefined && existing.registration.webDirectory !== null) {
    notice(`serving the synchronized cockpit composition for ${repositoryRoots.join(', ')}`);
    return {
      repositoryRoots,
      webDirectory: existing.registration.webDirectory,
      apiDirectory: existing.registration.apiDirectory,
    };
  }

  const cacheRoot = path.join(options.stateDirectory, COMPOSITIONS_DIRECTORY);
  const outputDirectory = path.join(cacheRoot, fingerprint(compositions, pluginRoots));
  const cached = cachedComposition(outputDirectory);
  if (cached !== undefined) return { ...cached, repositoryRoots };

  fs.mkdirSync(cacheRoot, { recursive: true });
  const stagingDirectory = path.join(cacheRoot, `.staging-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(stagingDirectory, { recursive: true });
  try {
    notice(`bundling the union of ${String(compositions.length)} live cockpit compositions`);
    await (options.bundle ?? bundleCockpitWeb)({
      pluginRoots,
      outDir: stagingDirectory,
      onNotice: notice,
    });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    repositoryRoots,
    webDirectory: path.join(outputDirectory, 'web'),
  };
}
