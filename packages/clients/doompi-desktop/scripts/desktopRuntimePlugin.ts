import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

interface DesktopRuntimePluginOptions {
  outDir: string;
  workspaceRoot: string;
}

export const DOOMPI_RUNTIME_PACKAGES = new Set([
  '@agimon-ai/doompi',
  '@agimon-ai/doompi-autostop',
  '@agimon-ai/doompi-cache',
  '@agimon-ai/doompi-config',
  '@agimon-ai/doompi-domain',
  '@agimon-ai/doompi-extension-contracts',
  '@agimon-ai/doompi-major-mode',
  '@agimon-ai/doompi-notification',
  '@agimon-ai/doompi-profile',
  '@agimon-ai/doompi-skill',
  '@agimon-ai/doompi-telemetry',
  '@agimon-ai/doompi-ui',
  '@earendil-works/pi-coding-agent',
  // The coding agent's experimental server entry imports this consumer-provided peer at runtime.
  '@earendil-works/pi-server',
]);
const DOOMPI_PACKAGE_DIRECTORIES = ['core', 'default', 'minor'] as const;
const PLATFORM_PACKAGE_SUFFIX = /-(darwin|linux)-(arm64|x64)$/u;
const EXTERNAL_RUNTIME_PACKAGES = new Set(['@earendil-works/pi-coding-agent']);

const WEB_RUNTIME_PACKAGES = new Set([
  '@agimon-ai/doompi-extension-contracts',
  '@agimon-ai/doompi-web-components',
  '@agimon-ai/doompi-web-security',
  '@earendil-works/pi-client',
  '@earendil-works/pi-coding-agent',
  '@simplewebauthn/browser',
  '@tanstack/react-router',
  '@tanstack/react-store',
  '@tanstack/store',
  'qrcode-generator',
  'react',
  'react-dom',
  'tailwindcss',
]);

/** Copies the non-JavaScript files required by the bundled desktop runtime. */
export function desktopRuntimePlugin(options: DesktopRuntimePluginOptions): Plugin {
  const target = `${process.platform}-${process.arch}`;
  const runtimePackages = new Set([...nativePackageCandidates(target), 'picomatch', 'postcss']);
  return {
    name: 'doompi-desktop-runtime-files',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      if (isExternalRuntimePackage(source)) return { id: source, external: true };
      const packageName = dependencyPackageName(source);
      if (packageName === undefined || !packageName.includes(target)) return null;
      runtimePackages.add(packageName);
      return { id: source, external: true };
    },
    transform(source, id) {
      if (id.includes('/doompi/') && id.includes('/src/adapters/modules/moduleResolution.')) {
        const original = 'path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))';
        if (source.includes(original)) {
          return source.replace(original, `(process.env.DOOMPI_PACKAGE_ROOT || ${original})`);
        }
      }
      if (!id.includes('/vite/dist/node/')) return null;
      const original = 'resolve(fileURLToPath(new URL("../../../src/node/constants.ts", import.meta.url)), "../../..")';
      if (!source.includes(original)) return null;
      return source.replace(original, `(process.env.DOOMPI_VITE_PACKAGE_ROOT || ${original})`);
    },
    writeBundle() {
      copyWebAssets(options.workspaceRoot, options.outDir);
      copyPackageManifest(options.workspaceRoot, options.outDir, 'packages/clients/doompi-web', 'doompi-web');
      copyPackageManifest(options.workspaceRoot, options.outDir, 'packages/clients/doompi-server', 'doompi-server');
      copyPackageManifest(options.workspaceRoot, options.outDir, 'packages/core/doompi', 'doompi');
      copyPackageManifest(
        options.workspaceRoot,
        options.outDir,
        'packages/core/doompi',
        'native/node_modules/@agimon-ai/doompi',
      );
      copyRuntimePackages(
        options.workspaceRoot,
        path.join(options.outDir, 'node_modules'),
        new Set([
          ...DOOMPI_RUNTIME_PACKAGES,
          `@agimon-ai/doompi-runner-rmux-${target}`,
          `@agimon-ai/doompi-runner-rtk-${target}`,
        ]),
        path.join(options.workspaceRoot, 'packages', 'core', 'doompi'),
      );
      copyPackageCatalog(options.workspaceRoot, options.outDir, target);
      copyRuntimePackages(options.workspaceRoot, path.join(options.outDir, 'native', 'node_modules'), runtimePackages);
      copyRuntimePackages(
        options.workspaceRoot,
        path.join(options.outDir, 'doompi-web', 'node_modules'),
        WEB_RUNTIME_PACKAGES,
        path.join(options.workspaceRoot, 'packages', 'clients', 'doompi-web'),
        new Set(['@earendil-works/pi-coding-agent']),
      );
      copyNpmRuntime(options.workspaceRoot, options.outDir);
      copyViteRuntime(options.workspaceRoot, options.outDir);
    },
  };
}

function copyWebAssets(workspaceRoot: string, outDir: string): void {
  const webRoot = path.join(workspaceRoot, 'packages', 'clients', 'doompi-web', 'dist');
  for (const directory of ['web', 'pwa']) {
    const source = path.join(webRoot, directory);
    if (!fs.existsSync(source))
      throw new Error(`Build @agimon-ai/doompi-web before the desktop runtime: ${source} is missing.`);
    fs.cpSync(source, path.join(outDir, 'doompi-web', 'dist', directory), { recursive: true });
  }
  fs.cpSync(
    path.join(workspaceRoot, 'packages', 'clients', 'doompi-web', 'src'),
    path.join(outDir, 'doompi-web', 'src'),
    { recursive: true },
  );
}

function copyPackageManifest(workspaceRoot: string, outDir: string, packagePath: string, artifactPath: string): void {
  const source = path.join(workspaceRoot, packagePath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(source, 'utf8')) as { name?: unknown; version?: unknown };
  const output = {
    name: manifest.name,
    version: manifest.version,
    type: 'module',
  };
  const destination = path.join(outDir, artifactPath, 'package.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
}

interface CatalogPackage {
  name: string;
  root: string;
  dependencies: string[];
}

export function bundledDoomPiPackages(workspaceRoot: string, target: string): CatalogPackage[] {
  const packages: CatalogPackage[] = [];
  const layerRoot = path.join(workspaceRoot, 'layers');
  const groupRoots = [
    ...DOOMPI_PACKAGE_DIRECTORIES.map((group) => path.join(workspaceRoot, 'packages', group)),
    ...fs
      .readdirSync(layerRoot, { withFileTypes: true })
      .filter((directory) => directory.isDirectory())
      .map((directory) => path.join(layerRoot, directory.name)),
  ];
  for (const groupRoot of groupRoots) {
    for (const directory of fs.readdirSync(groupRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const root = path.join(groupRoot, directory.name);
      const manifestPath = path.join(root, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        name?: unknown;
        files?: unknown;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@agimon-ai/doompi')) continue;
      const platform = manifest.name.match(PLATFORM_PACKAGE_SUFFIX);
      if (platform && `${platform[1]}-${platform[2]}` !== target) continue;
      if (Array.isArray(manifest.files) && manifest.files.includes('dist') && !fs.existsSync(path.join(root, 'dist'))) {
        throw new Error(`Build ${manifest.name} before packaging DoomPi Desktop.`);
      }
      packages.push({
        name: manifest.name,
        root,
        dependencies: [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.optionalDependencies ?? {}),
        ],
      });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function copyPackageCatalog(workspaceRoot: string, outDir: string, target: string): void {
  const catalogRoot = path.join(outDir, 'catalog');
  fs.mkdirSync(catalogRoot, { recursive: true });
  const entries = bundledDoomPiPackages(workspaceRoot, target);
  const catalogNames = new Set(entries.map((entry) => entry.name));
  const catalog: Record<string, { archive: string; dependencies: string[] }> = {};
  for (const entry of entries) {
    const output = execFileSync('pnpm', ['pack', '--pack-destination', catalogRoot, '--json'], {
      cwd: entry.root,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const packed = JSON.parse(output) as { filename?: unknown };
    if (typeof packed.filename !== 'string') throw new Error(`pnpm pack returned no archive for ${entry.name}.`);
    catalog[entry.name] = {
      archive: path.basename(packed.filename),
      dependencies: entry.dependencies.filter((dependency) => catalogNames.has(dependency)).sort(),
    };
  }
  fs.writeFileSync(
    path.join(catalogRoot, 'index.json'),
    `${JSON.stringify({ version: 1, packages: catalog }, null, 2)}\n`,
  );
}

function dependencyPackageName(source: string): string | undefined {
  if (source.startsWith('@')) {
    const [scope, name] = source.split('/');
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : undefined;
  }
  const [name] = source.split('/');
  return name === undefined || name === '' || path.isAbsolute(source) ? undefined : name;
}

/** Keeps identity-sensitive runtime packages outside the generated bundle. */
export function isExternalRuntimePackage(source: string): boolean {
  const packageName = dependencyPackageName(source);
  return packageName !== undefined && EXTERNAL_RUNTIME_PACKAGES.has(packageName);
}
function copyRuntimePackages(
  workspaceRoot: string,
  destinationRoot: string,
  packages: ReadonlySet<string>,
  resolutionRoot: string = workspaceRoot,
  shallowPackages: ReadonlySet<string> = new Set(),
): void {
  const rootRequire = createRequire(path.join(resolutionRoot, 'package.json'));
  const copied = new Set<string>();

  const copy = (packageName: string, require: NodeJS.Require): void => {
    if (copied.has(packageName)) return;
    // A declared runtime root wins over a transitive version encountered first.
    // The flat artifact cannot represent pnpm's nested version graph.
    if (require !== rootRequire && packages.has(packageName)) return;
    const manifestPath = resolveManifest(require, packageName);
    const source = path.dirname(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      files?: unknown;
    };
    const destination = path.join(destinationRoot, ...packageName.split('/'));
    copyPackagePayload(workspaceRoot, source, destination, manifest.files);
    copied.add(packageName);
    if (shallowPackages.has(packageName)) return;
    const dependencyRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, dependencyRequire);
  };

  for (const packageName of packages) copy(packageName, rootRequire);
}

function copyPackagePayload(workspaceRoot: string, source: string, destination: string, files: unknown): void {
  const packagesRoot = path.join(workspaceRoot, 'packages');
  const relative = path.relative(packagesRoot, source);
  const workspacePackage = relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const publishedFiles = Array.isArray(files)
    ? files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!workspacePackage || publishedFiles.length === 0) {
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) => path.basename(entry) !== 'node_modules',
    });
    return;
  }

  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(source, 'package.json'), path.join(destination, 'package.json'));
  for (const entry of publishedFiles) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from) || entry === 'package.json') continue;
    fs.cpSync(from, path.join(destination, entry), { recursive: true, dereference: true });
  }
}
function resolveManifest(require: NodeJS.Require, packageName: string): string {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    for (const searchPath of require.resolve.paths(packageName) ?? []) {
      const candidate = path.join(searchPath, ...packageName.split('/'), 'package.json');
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Could not locate package.json for ${packageName}.`);
  }
}

function nativePackageCandidates(target: string): string[] {
  const binaryTarget = process.platform === 'linux' ? `${target}-gnu` : target;
  return [`@rolldown/binding-${binaryTarget}`, `@tailwindcss/oxide-${binaryTarget}`, `lightningcss-${binaryTarget}`];
}

function copyNpmRuntime(workspaceRoot: string, outDir: string): void {
  const require = createRequire(path.join(workspaceRoot, 'packages', 'clients', 'doompi-desktop', 'package.json'));
  const root = path.dirname(resolveManifest(require, 'npm'));
  fs.cpSync(root, path.join(outDir, 'vendor', 'npm'), { recursive: true, dereference: true });
}
function copyViteRuntime(workspaceRoot: string, outDir: string): void {
  const require = createRequire(path.join(workspaceRoot, 'package.json'));
  const root = path.dirname(require.resolve('vite/package.json'));
  const destination = path.join(outDir, 'vendor', 'vite');
  fs.mkdirSync(path.join(destination, 'dist'), { recursive: true });
  fs.cpSync(path.join(root, 'dist', 'client'), path.join(destination, 'dist', 'client'), { recursive: true });
  copyManifest(root, destination);
}

function copyManifest(sourceRoot: string, destinationRoot: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
    type?: unknown;
  };
  fs.writeFileSync(
    path.join(destinationRoot, 'package.json'),
    `${JSON.stringify({ name: manifest.name, version: manifest.version, type: manifest.type }, null, 2)}\n`,
  );
}
