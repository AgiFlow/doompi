import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

interface DesktopRuntimePluginOptions {
  outDir: string;
  workspaceRoot: string;
}

const PLATFORM_NAME: Readonly<Record<string, string>> = {
  darwin: 'darwin',
  linux: 'linux',
};

const DOOMPI_RUNTIME_PACKAGES = new Set([
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
]);

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
      const packageName = dependencyPackageName(source);
      if (packageName === undefined || !packageName.includes(target)) return null;
      runtimePackages.add(packageName);
      return { id: source, external: true };
    },
    transform(source, id) {
      if (id.includes('/doompi/src/adapters/modules/moduleResolution.')) {
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
      copyNativeBinaries(options.workspaceRoot, options.outDir);
      // Core extensions are resolved by package name after startup, so they must
      // remain real packages beside the bundled runtime rather than only chunks.
      copyRuntimePackages(options.workspaceRoot, path.join(options.outDir, 'node_modules'), DOOMPI_RUNTIME_PACKAGES);
      copyRuntimePackages(options.workspaceRoot, path.join(options.outDir, 'native', 'node_modules'), runtimePackages);
      copyRuntimePackages(
        options.workspaceRoot,
        path.join(options.outDir, 'doompi-web', 'node_modules'),
        WEB_RUNTIME_PACKAGES,
        new Set(['@earendil-works/pi-coding-agent']),
      );
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

function copyNativeBinaries(workspaceRoot: string, outDir: string): void {
  const platform = PLATFORM_NAME[process.platform];
  if (platform === undefined || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`The desktop runtime does not support native binaries for ${process.platform}-${process.arch}.`);
  }
  for (const binary of ['rmux', 'rtk']) {
    const packageName = `doompi-runner-${binary}-${platform}-${process.arch}`;
    const source = path.join(workspaceRoot, 'packages', 'default', packageName, 'vendor');
    if (!fs.existsSync(source)) throw new Error(`The native payload is missing at ${source}.`);
    fs.cpSync(source, path.join(outDir, 'native', binary), { recursive: true });
  }
}

function dependencyPackageName(source: string): string | undefined {
  if (source.startsWith('@')) {
    const [scope, name] = source.split('/');
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : undefined;
  }
  const [name] = source.split('/');
  return name === undefined || name === '' || path.isAbsolute(source) ? undefined : name;
}

function copyRuntimePackages(
  workspaceRoot: string,
  destinationRoot: string,
  packages: ReadonlySet<string>,
  shallowPackages: ReadonlySet<string> = new Set(),
): void {
  const rootRequire = createRequire(path.join(workspaceRoot, 'package.json'));
  const copied = new Set<string>();

  const copy = (packageName: string, require: NodeJS.Require): void => {
    if (copied.has(packageName)) return;
    const manifestPath = resolveManifest(require, packageName);
    const source = path.dirname(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const destination = path.join(destinationRoot, ...packageName.split('/'));
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) => path.basename(entry) !== 'node_modules',
    });
    copied.add(packageName);
    if (shallowPackages.has(packageName)) return;
    const dependencyRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copy(dependency, dependencyRequire);
  };

  for (const packageName of packages) copy(packageName, rootRequire);
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
