import { pathToFileURL } from 'node:url';
import { isLocalPackageSpecifier, type MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import {
  isSandboxHarnessModule,
  SANDBOX_HARNESS_EXPORT_SUBPATH,
  type SandboxHarnessModule,
} from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { consumerPackageEntry, localPackageExport, splitPackageSpecifier } from './modules/moduleResolution.ts';

export interface SandboxHarnessResolution {
  /** Configured package specifier that answered for the sandbox subpath. */
  specifier: string;
  /** Absolute path of the module the harness imports. */
  entry: string;
}

interface ConfiguredPackage {
  specifier: string;
  /** Root the specifier resolves against when it is a local path. */
  baseDirectory: string;
}

function configuredPackages(config: MajorModesConfig, layers: readonly string[]): ConfiguredPackage[] {
  const definitions = [
    ...(config.default ? [config.default] : []),
    ...layers.map((layerName) => {
      const layer = config.layers[layerName];
      if (!layer) throw new Error(`Unknown layer: ${layerName}`);
      return layer;
    }),
  ];
  const packages: ConfiguredPackage[] = [];
  for (const definition of definitions) {
    for (const configured of definition.packages ?? []) {
      const specifier = typeof configured === 'string' ? configured : configured.name;
      const candidate = { specifier, baseDirectory: definition.baseDirectory };
      if (!packages.some((entry) => entry.specifier === specifier && entry.baseDirectory === candidate.baseDirectory)) {
        packages.push(candidate);
      }
    }
  }
  return packages;
}

function sandboxEntryFor(configured: ConfiguredPackage, repoRoot: string): string | undefined {
  if (isLocalPackageSpecifier(configured.specifier)) {
    return localPackageExport(configured.specifier, configured.baseDirectory, SANDBOX_HARNESS_EXPORT_SUBPATH);
  }
  const { name } = splitPackageSpecifier(configured.specifier);
  return consumerPackageEntry(`${name}${SANDBOX_HARNESS_EXPORT_SUBPATH.slice(1)}`, repoRoot);
}

/**
 * Finds the single sandbox harness the selected composition provides.
 *
 * Exactly one package may answer: two sandbox providers cannot both own the
 * launch, and which one wins would otherwise depend on declaration order.
 */
export function resolveSandboxHarnessEntry(
  config: MajorModesConfig,
  layers: readonly string[],
  repoRoot: string,
): SandboxHarnessResolution | undefined {
  const resolutions: SandboxHarnessResolution[] = [];
  for (const configured of configuredPackages(config, layers)) {
    const entry = sandboxEntryFor(configured, repoRoot);
    if (entry && !resolutions.some((resolution) => resolution.entry === entry)) {
      resolutions.push({ specifier: configured.specifier, entry });
    }
  }
  if (resolutions.length > 1) {
    const names = resolutions.map((resolution) => resolution.specifier).join(', ');
    throw new Error(
      `Multiple sandbox harnesses in the selected composition: ${names}. Keep exactly one sandbox layer in the major mode.`,
    );
  }
  return resolutions[0];
}

/** Imports and validates a sandbox harness entry file. */
export async function loadSandboxHarness(entry: string): Promise<SandboxHarnessModule> {
  const imported: unknown = await import(pathToFileURL(entry).href);
  if (isSandboxHarnessModule(imported)) return imported;
  const fallback = (imported as { default?: unknown } | null)?.default;
  if (isSandboxHarnessModule(fallback)) return fallback;
  throw new Error(`Sandbox harness at ${entry} does not export launchSandbox().`);
}
