import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SignedBundleManifest } from '@agimon-ai/doompi-web-security';
import { createBundleSigner, type BundleSigner } from '@agimon-ai/doompi-web-security/node';

export interface BundleTrustView {
  publicKey: string;
  revision: number;
}

/**
 * One signed manifest and the directory it was signed over.
 *
 * They travel together because a page verifies each asset it fetches against
 * the manifest it was given. If the manifest advanced to a new sync generation
 * while asset reads still resolved against the previous directory, every fetch
 * would fail its digest check and the bundle would be refused. Handing callers
 * one record removes the chance of pairing them wrongly.
 */
export interface PublishedBundle {
  signed: SignedBundleManifest;
  assetsDir: string;
}

export interface BundlePublication {
  current(): PublishedBundle | undefined;
  trust(): BundleTrustView | undefined;
  refresh(): PublishedBundle | undefined;
}

/** Signed immutable plugin compositions addressable by identity and revision. */
export interface PluginBundlePublication {
  publish(compositionId: string, assetsDir: string): PublishedBundle | undefined;
  get(compositionId: string, revision: number): PublishedBundle | undefined;
  publicKey(): string | undefined;
  close(): void;
}

export interface BundlePublicationOptions {
  /** Read on each publication, so a new sync generation can be adopted in place. */
  assetsDir: () => string;
  stateDir: string;
  onNotice?: (message: string) => void;
}

/**
 * Content this signer has published before, newest last.
 *
 * The signer revision only ever increases, which stops a paired device being
 * handed a manifest it has already seen superseded. It does not stop the same
 * hub re-serving older cockpit code under a fresh, higher revision, which is
 * what checking out an earlier commit and syncing does. That is allowed, but it
 * should not be silent, so republished content is named in the log.
 *
 * Process-local and bounded: this is a report, not a control.
 */
const publishedContent: Array<{ revision: number; digest: string }> = [];
const PUBLICATION_HISTORY_LIMIT = 32;

/**
 * Digest of what the bundle contains, ignoring which publication carried it.
 *
 * `revision` and `builtAt` change on every signing, so a digest over the whole
 * manifest would never repeat and could never spot a downgrade.
 */
function assetSetDigest(manifest: SignedBundleManifest): string {
  const assets = [...manifest.manifest.assets]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((asset) => `${asset.path}:${asset.sha256}:${String(asset.byteLength)}`)
    .join('\n');
  return createHash('sha256').update(assets).digest('hex');
}

function noteRepublishedContent(bundle: PublishedBundle, notice: (message: string) => void): void {
  const revision = bundle.signed.manifest.revision;
  const digest = assetSetDigest(bundle.signed);
  const earlier = publishedContent.find((entry) => entry.digest === digest && entry.revision < revision);
  if (earlier !== undefined) {
    notice(
      `the cockpit bundle repeats content already published as revision ${String(earlier.revision)}; ` +
        `paired devices will accept it as revision ${String(revision)}`,
    );
  }
  publishedContent.push({ revision, digest });
  if (publishedContent.length > PUBLICATION_HISTORY_LIMIT) publishedContent.shift();
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
  let published: PublishedBundle | undefined;
  let publishedRootIdentity: string | undefined;

  const signCurrent = (sign: (assetsDir: string) => SignedBundleManifest | undefined): PublishedBundle | undefined => {
    const assetsDir = options.assetsDir();
    const signed = sign(assetsDir);
    return signed === undefined ? undefined : { signed, assetsDir };
  };

  try {
    signer = createBundleSigner(options.stateDir, notice);
    const first = signCurrent((assetsDir) => signer?.sign(assetsDir));
    if (first === undefined) notice('the cockpit bundle is empty and cannot be published');
    else {
      published = first;
      publishedRootIdentity = assetRootIdentity(first.assetsDir);
      noteRepublishedContent(published, notice);
    }
  } catch (error) {
    notice(`the cockpit bundle could not be signed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const refresh = (): PublishedBundle | undefined => {
    if (signer === undefined) return published;
    try {
      const next = signCurrent((assetsDir) => signer?.refresh(assetsDir));
      if (next === undefined) {
        notice('the refreshed cockpit bundle is empty; keeping the last signed publication');
        return published;
      }
      published = next;
      publishedRootIdentity = assetRootIdentity(next.assetsDir);
      noteRepublishedContent(published, notice);
    } catch (error) {
      notice(`the refreshed cockpit bundle was refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    return published;
  };

  const refreshAfterRootReplacement = (): void => {
    // A changed asset root means a new sync generation, or the same directory
    // replaced underneath; either way the last publication no longer describes
    // what would be served.
    const currentRootIdentity = published === undefined ? undefined : assetRootIdentity(options.assetsDir());
    if (published !== undefined && options.assetsDir() !== published.assetsDir) {
      refresh();
      return;
    }
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
        : { publicKey: published.signed.publicKey, revision: published.signed.manifest.revision };
    },
    refresh,
  };
}

const PLUGIN_PUBLICATION_LIMIT = 32;

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
      while (byRoute.size > PLUGIN_PUBLICATION_LIMIT) {
        const oldest = byRoute.entries().next().value as [string, PublishedBundle] | undefined;
        if (oldest === undefined) break;
        byRoute.delete(oldest[0]);
        for (const [id, candidate] of byComposition) {
          if (candidate === oldest[1]) byComposition.delete(id);
        }
        fs.rmSync(oldest[1].assetsDir, { recursive: true, force: true });
      }
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
