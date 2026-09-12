import type { Plugin } from 'vite';
import {
  BUNDLE_ASSET_POLICY_PATH,
  BUNDLE_ASSET_POLICY_VERSION,
  type BundleAssetPolicy,
} from '@agimon-ai/doompi-core/web';

const OPTIONAL_PACKAGES = ['/node_modules/mermaid/', '/node_modules/pdfjs-dist/'] as const;

interface PolicyOutput {
  type: 'asset' | 'chunk';
  isEntry?: boolean;
  facadeModuleId?: string | null;
  modules?: Record<string, unknown>;
  imports?: string[];
  dynamicImports?: string[];
  referencedFiles?: string[];
  code?: string;
  source?: string | Uint8Array;
  viteMetadata?: { importedAssets?: Set<string> };
}

function packageOwner(output: PolicyOutput, owned: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  const ids = Object.keys(output.modules ?? {});
  return OPTIONAL_PACKAGES.find(
    (dependency) =>
      ids.some((id) => id.replaceAll('\\', '/').includes(dependency)) &&
      ids.every((id) => owned.get(dependency)?.has(id)),
  );
}

function references(output: PolicyOutput): string[] {
  if (output.type === 'asset') return [];
  return [
    ...(output.imports ?? []),
    ...(output.dynamicImports ?? []),
    ...(output.referencedFiles ?? []),
    ...(output.viteMetadata?.importedAssets ?? []),
  ];
}

/** Classifies only output owned exclusively by a known optional dependency graph. */
export function classifyOptionalBundleAssets(
  bundle: Readonly<Record<string, PolicyOutput>>,
  moduleDependencies?: (id: string) => readonly string[] | undefined,
): string[] {
  const outputs = new Map(Object.entries(bundle));
  const owned = new Map<string, Set<string>>();
  for (const dependency of OPTIONAL_PACKAGES) {
    const modules = new Set<string>();
    const visit = (id: string): void => {
      // Application and unresolved virtual modules never inherit optional ownership.
      if (modules.has(id) || !id.replaceAll('\\', '/').includes('/node_modules/')) return;
      modules.add(id);
      for (const imported of moduleDependencies?.(id) ?? []) visit(imported);
    };
    for (const output of outputs.values()) {
      for (const id of Object.keys(output.modules ?? {})) {
        if (id.replaceAll('\\', '/').includes(dependency)) visit(id);
      }
    }
    owned.set(dependency, modules);
  }
  const graphReferences = (output: PolicyOutput): string[] => {
    const source =
      output.code ??
      (typeof output.source === 'string'
        ? output.source
        : output.source === undefined
          ? ''
          : new TextDecoder().decode(output.source));
    return [
      ...references(output),
      ...[...outputs]
        .filter(([fileName, candidate]) => candidate.type === 'asset' && source.includes(fileName))
        .map(([fileName]) => fileName),
    ];
  };
  const optionalRoots = new Map<string, string>();
  for (const [fileName, output] of outputs) {
    if (output.type !== 'chunk') continue;
    const owner = packageOwner(output, owned);
    const facade = output.facadeModuleId?.replaceAll('\\', '/');
    if (
      owner !== undefined &&
      (!output.isEntry || OPTIONAL_PACKAGES.some((dependency) => facade?.includes(dependency)))
    ) {
      optionalRoots.set(fileName, owner);
    }
  }

  const eager = new Set<string>();
  const visitEager = (fileName: string): void => {
    if (eager.has(fileName)) return;
    eager.add(fileName);
    const output = outputs.get(fileName);
    if (output === undefined) return;
    for (const reference of graphReferences(output)) {
      const deferredRoot = optionalRoots.has(reference) && output.dynamicImports?.includes(reference);
      if (!deferredRoot) visitEager(reference);
    }
  };
  for (const [fileName, output] of outputs) {
    if (fileName === 'index.html' || (output.type === 'chunk' && output.isEntry && !optionalRoots.has(fileName)))
      visitEager(fileName);
  }

  const optional = new Set<string>();
  const visitOptional = (fileName: string, owner: string): void => {
    if (eager.has(fileName) || optional.has(fileName)) return;
    const output = outputs.get(fileName);
    if (output === undefined) return;
    if (output.type === 'chunk') {
      const ids = Object.keys(output.modules ?? {});
      if (ids.length === 0 || !ids.every((id) => owned.get(owner)?.has(id))) {
        visitEager(fileName);
        return;
      }
    }
    optional.add(fileName);
    for (const reference of graphReferences(output)) {
      const referencedRootOwner = optionalRoots.get(reference);
      if (referencedRootOwner === undefined || referencedRootOwner === owner) visitOptional(reference, owner);
    }
  };
  for (const [fileName, owner] of optionalRoots) visitOptional(fileName, owner);
  return [...optional]
    .filter((fileName) => !eager.has(fileName) && !fileName.endsWith('.map'))
    .map((fileName) => `/${fileName}`)
    .sort();
}

/** Emits an authenticated v1 policy derived from Rollup's module and resource graph. */
export function bundleAssetPolicyPlugin(): Plugin {
  return {
    name: 'doompi-bundle-asset-policy',
    generateBundle(_options, bundle) {
      const policy: BundleAssetPolicy = {
        version: BUNDLE_ASSET_POLICY_VERSION,
        optional: classifyOptionalBundleAssets(bundle, (id) => {
          const info = this.getModuleInfo(id);
          return info === null ? undefined : [...info.importedIds, ...info.dynamicallyImportedIds];
        }),
      };
      this.emitFile({
        type: 'asset',
        fileName: BUNDLE_ASSET_POLICY_PATH.slice(1),
        source: `${JSON.stringify(policy)}\n`,
      });
    },
  };
}
