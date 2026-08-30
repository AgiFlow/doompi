import fs from 'node:fs';
import type { SignedBundleManifest } from '@agimon-ai/doompi-web-security';
import { createBundleSigner, type BundleSigner } from '@agimon-ai/doompi-web-security/node';

export interface BundleTrustView {
  publicKey: string;
  revision: number;
}

export interface BundlePublication {
  current(): SignedBundleManifest | undefined;
  trust(): BundleTrustView | undefined;
  refresh(): SignedBundleManifest | undefined;
}

export interface BundlePublicationOptions {
  assetsDir: string;
  stateDir: string;
  onNotice?: (message: string) => void;
}

function assetRootIdentity(assetsDir: string): string | undefined {
  try {
    const stat = fs.statSync(assetsDir, { bigint: true });
    return stat.isDirectory() ? `${String(stat.dev)}:${String(stat.ino)}:${String(stat.mtimeNs)}` : undefined;
  } catch {
    return undefined;
  }
}
/** Holds the last complete signed publication while files at the synced path are replaced. */
export function createBundlePublication(options: BundlePublicationOptions): BundlePublication {
  const notice = options.onNotice ?? ((): void => {});
  let signer: BundleSigner | undefined;
  let published: SignedBundleManifest | undefined;
  let publishedRootIdentity: string | undefined;

  try {
    signer = createBundleSigner(options.stateDir, notice);
    published = signer.sign(options.assetsDir);
    if (published === undefined) notice('the cockpit bundle is empty and cannot be published');
    else publishedRootIdentity = assetRootIdentity(options.assetsDir);
  } catch (error) {
    notice(`the cockpit bundle could not be signed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const refresh = (): SignedBundleManifest | undefined => {
    if (signer === undefined) return published;
    try {
      const next = signer.refresh(options.assetsDir);
      if (next === undefined) {
        notice('the refreshed cockpit bundle is empty; keeping the last signed publication');
        return published;
      }
      published = next;
      publishedRootIdentity = assetRootIdentity(options.assetsDir);
    } catch (error) {
      notice(`the refreshed cockpit bundle was refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    return published;
  };

  const refreshAfterRootReplacement = (): void => {
    const currentRootIdentity = assetRootIdentity(options.assetsDir);
    if (currentRootIdentity !== undefined && currentRootIdentity !== publishedRootIdentity) refresh();
  };

  return {
    current: () => {
      refreshAfterRootReplacement();
      return published;
    },
    trust: () => {
      refreshAfterRootReplacement();
      return published === undefined
        ? undefined
        : { publicKey: published.publicKey, revision: published.manifest.revision };
    },
    refresh,
  };
}
