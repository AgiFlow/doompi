import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DoomApiMount, DoomWebComposition } from '../../exports/packageApi';
import type { SyncRegistration } from '../syncRegistration';
import { createPluginBundlePublication, type PublishedBundle } from '../bundlePublication';

/** Signs one immutable browser composition for each independently owned mount. */
export function createWebCompositions(stateDirectory: string, onNotice: (message: string) => void) {
  const publication = createPluginBundlePublication(stateDirectory, onNotice);
  let shell: PublishedBundle | undefined;
  const mounts = new Map<string, DoomWebComposition>();
  const keyOf = (mount: DoomApiMount): string =>
    mount.scope === 'global'
      ? 'global'
      : mount.scope === 'workspace'
        ? `workspace:${mount.workspaceId}`
        : `session:${mount.sessionId}`;
  return {
    publishShell(registration: SyncRegistration): void {
      if (registration.webDirectory === null) return;
      const id = crypto.createHash('sha256').update(`shell:${registration.generation}`).digest('hex');
      shell = publication.publish(id, registration.webDirectory);
      if (!shell) throw new Error('Could not publish the global web shell.');
    },
    shellTrust: () =>
      shell === undefined ? undefined : { publicKey: shell.signed.publicKey, revision: shell.signed.manifest.revision },
    publish(
      mount: DoomApiMount,
      registration: SyncRegistration,
      channels: readonly string[],
    ): DoomWebComposition | undefined {
      if (registration.webDirectory === null) return undefined;
      const directory = path.join(path.dirname(registration.webDirectory), 'plugins');
      const id = crypto
        .createHash('sha256')
        .update(`${keyOf(mount)}:${registration.generation}`)
        .digest('hex');
      const published = publication.publish(id, directory);
      if (!published) throw new Error(`Could not publish ${keyOf(mount)} web composition.`);
      const revision = published.signed.manifest.revision;
      const base = `/api/web-plugins/${id}/${String(revision)}`;
      const composition: DoomWebComposition = {
        id,
        scope: mount.scope,
        revision,
        manifestUrl: `${base}/manifest`,
        rawAssetBaseUrl: `${base}/assets`,
        verifiedAssetBaseUrl: `/verified-plugins/${id}/${String(revision)}`,
        entryPath: '/composition.js',
        stylePaths: published.signed.manifest.assets
          .filter((asset) => asset.contentType === 'text/css')
          .map((asset) => asset.path),
        channels: [...channels],
      };
      mounts.set(keyOf(mount), composition);
      return composition;
    },
    get: (mount: DoomApiMount) => mounts.get(keyOf(mount)),
    remove: (mount: DoomApiMount) => {
      const previous = mounts.get(keyOf(mount));
      if (previous) publication.release(previous.id);
      mounts.delete(keyOf(mount));
    },
    publicKey: () => publication.publicKey(),
    async request(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (
        (url.pathname === '/bundle-manifest.json' || url.pathname.startsWith('/bundle-assets/')) &&
        request.method !== 'GET' &&
        request.method !== 'HEAD'
      )
        return new Response(null, { status: 405 });
      if (url.pathname === '/bundle-manifest.json') {
        if (!shell) return new Response(null, { status: 404 });
        return Response.json(shell.signed);
      }
      const shellAsset = /^\/bundle-assets\/(\d+)(\/.*)$/u.exec(url.pathname);
      if (shellAsset) {
        if (!shell || Number(shellAsset[1]) !== shell.signed.manifest.revision)
          return new Response(null, { status: 404 });
        const asset = shell.signed.manifest.assets.find((entry) => entry.path === shellAsset[2]);
        if (!asset) return new Response(null, { status: 404 });
        const bytes = await fs.promises.readFile(path.join(shell.assetsDir, asset.path));
        return new Response(request.method === 'HEAD' ? null : bytes, {
          headers: { 'content-type': asset.contentType, 'x-content-type-options': 'nosniff' },
        });
      }
      const match = /^\/api\/web-plugins\/([a-f0-9]{64})\/(\d+)\/(manifest|assets(?:\/.*)?)$/u.exec(url.pathname);
      if (!match) return undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      const bundle = publication.get(match[1], Number(match[2]));
      if (!bundle) return Response.json({ error: 'Plugin generation not found.' }, { status: 404 });
      if (match[3] === 'manifest') return Response.json(bundle.signed);
      const assetPath = match[3].slice('assets'.length);
      const asset = bundle.signed.manifest.assets.find((candidate) => candidate.path === assetPath);
      if (!asset) return Response.json({ error: 'Plugin asset not found.' }, { status: 404 });
      const bytes = await fs.promises.readFile(path.join(bundle.assetsDir, asset.path));
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-type': asset.contentType,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    },
    close() {
      mounts.clear();
      publication.close();
    },
  };
}
