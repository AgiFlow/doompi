import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB_PACKAGE = '@agimon-ai/doompi-web';
const WEB_PACKAGE_ROOT_ENV = 'DOOMPI_WEB_PACKAGE_ROOT';
const BUNDLER_ENTRY = ['dist', 'bundler.mjs'];

export interface WebBundleSyncInput {
  repoRoot: string;
  /** Resolved extension entry paths from the sync state; package roots derive from them. */
  resolvedEntries: Record<string, string>;
  environment?: NodeJS.ProcessEnv;
  /** Immutable generation directory that receives web/, generated/, and registries. */
  outputDirectory: string;
  onNotice?: (message: string) => void;
  /** Test seam over the dynamic import of the doompi-web bundler module. */
  importBundler?: (url: string) => Promise<unknown>;
  /** Test seam over package resolution, which native require makes environment-dependent. */
  resolveWebRoot?: (repoRoot: string, environment: NodeJS.ProcessEnv) => string | undefined;
}

export type WebBundleSyncResult =
  | { status: 'bundled'; assetsDir: string; pluginIds: string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

interface BundlerModule {
  bundleCockpitWeb?: (options: {
    pluginRoots: readonly string[];
    outDir: string;
    onNotice?: (message: string) => void;
  }) => Promise<{ assetsDir: string; pluginIds: string[] }>;
}

/** Walks from a resolved module path up to the directory owning its package.json. */
function packageRootOf(entryPath: string): string | undefined {
  let dir = path.dirname(entryPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveWebPackageRoot(repoRoot: string, environment: NodeJS.ProcessEnv): string | undefined {
  const override = environment[WEB_PACKAGE_ROOT_ENV];
  if (override !== undefined && override !== '') return path.resolve(override);
  try {
    return path.dirname(createRequire(path.join(repoRoot, 'package.json')).resolve(`${WEB_PACKAGE}/package.json`));
  } catch {
    return undefined; // Not installed for this repository; a normal composition.
  }
}

/** Builds the cockpit bundle directly inside an unpublished sync generation. */
export async function syncWebBundle(input: WebBundleSyncInput): Promise<WebBundleSyncResult> {
  const environment = input.environment ?? process.env;
  const notice = input.onNotice ?? ((): void => {});
  const webRoot = (input.resolveWebRoot ?? resolveWebPackageRoot)(input.repoRoot, environment);
  if (webRoot === undefined) {
    return { status: 'skipped', reason: `${WEB_PACKAGE} is not installed; the cockpit keeps its packaged bundle` };
  }
  const bundlerPath = path.join(webRoot, ...BUNDLER_ENTRY);
  if (!fs.existsSync(bundlerPath)) {
    return { status: 'skipped', reason: `${bundlerPath} is missing; build ${WEB_PACKAGE} first` };
  }

  const pluginRoots = [
    ...new Set(
      Object.values(input.resolvedEntries)
        .map(packageRootOf)
        .filter((root): root is string => root !== undefined),
    ),
  ];

  try {
    const importBundler = input.importBundler ?? ((url: string) => import(url));
    const bundler = (await importBundler(pathToFileURL(bundlerPath).href)) as BundlerModule;
    if (typeof bundler.bundleCockpitWeb !== 'function') {
      return { status: 'failed', reason: `${bundlerPath} exports no bundleCockpitWeb` };
    }
    fs.rmSync(input.outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(input.outputDirectory, { recursive: true });
    const result = await bundler.bundleCockpitWeb({
      pluginRoots,
      outDir: input.outputDirectory,
      onNotice: notice,
    });
    return {
      status: 'bundled',
      assetsDir: result.assetsDir,
      pluginIds: result.pluginIds,
    };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
