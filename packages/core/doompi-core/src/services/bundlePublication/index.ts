import fs from 'node:fs';
import path from 'node:path';

import type { SignedBundleManifest } from '@agimon-ai/doompi-web-security';
import { createBundleSigner, type BundleSigner } from '@agimon-ai/doompi-web-security/node';

export interface PublishedBundle {
  signed: SignedBundleManifest;
  assetsDir: string;
}

export interface PluginBundlePublication {
  publish(compositionId: string, assetsDir: string): PublishedBundle | undefined;
  get(compositionId: string, revision: number): PublishedBundle | undefined;
  publicKey(): string | undefined;
  release(compositionId: string): void;
  close(): void;
}

/**
 * Signs synchronized plugin generations without replacing the stable shell publication.
 *
 * Publications are retained by the exact identity and revision advertised to pages, so
 * a concurrent sync cannot pair an old manifest with bytes from a new generation.
 */
export function createPluginBundlePublication(
  stateDir: string,
  onNotice: (message: string) => void = () => {},
): PluginBundlePublication {
  let signer: BundleSigner | undefined;
  try {
    signer = createBundleSigner(stateDir, onNotice);
  } catch (error) {
    onNotice(`plugin compositions could not be signed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const byComposition = new Map<string, PublishedBundle>();
  const byRoute = new Map<string, PublishedBundle>();
  const publicationRoot =
    signer === undefined ? undefined : fs.mkdtempSync(path.join(stateDir, 'plugin-publications-'));
  let closed = false;
  const routeKey = (compositionId: string, revision: number): string => `${compositionId}:${String(revision)}`;
  const publish = (compositionId: string, assetsDir: string): PublishedBundle | undefined => {
    if (closed) return undefined;
    const existing = byComposition.get(compositionId);
    if (existing !== undefined) return existing;
    if (signer === undefined || publicationRoot === undefined) return undefined;
    const stagingRoot = fs.mkdtempSync(path.join(publicationRoot, '.staging-'));
    const snapshot = path.join(stagingRoot, 'assets');
    try {
      fs.cpSync(assetsDir, snapshot, { recursive: true });
      const signed = signer.sign(snapshot);
      if (signed === undefined) {
        onNotice(`plugin composition '${compositionId}' is empty and cannot be published`);
        return undefined;
      }
      const retainedDirectory = path.join(publicationRoot, `${compositionId}-${String(signed.manifest.revision)}`);
      fs.renameSync(snapshot, retainedDirectory);
      const published = { signed, assetsDir: retainedDirectory };
      byComposition.set(compositionId, published);
      byRoute.set(routeKey(compositionId, signed.manifest.revision), published);
      return published;
    } catch (error) {
      onNotice(
        `plugin composition '${compositionId}' could not be signed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  };

  return {
    publish,
    release(compositionId) {
      const bundle = byComposition.get(compositionId);
      if (!bundle) return;
      byComposition.delete(compositionId);
      byRoute.delete(routeKey(compositionId, bundle.signed.manifest.revision));
      fs.rmSync(bundle.assetsDir, { recursive: true, force: true });
    },
    get: (compositionId, revision) => byRoute.get(routeKey(compositionId, revision)),
    publicKey: () => signer?.publicKey(),
    close: () => {
      if (closed) return;
      closed = true;
      byComposition.clear();
      byRoute.clear();
      if (publicationRoot !== undefined) fs.rmSync(publicationRoot, { recursive: true, force: true });
    },
  };
}
