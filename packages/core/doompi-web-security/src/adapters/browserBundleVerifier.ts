import {
  type BundleManifest,
  type SignedBundleManifest,
  assetFor,
  canonicalManifest,
  isSignedBundleManifest,
} from '../types/bundleManifest.ts';

export type BundleVerificationFailure =
  | { code: 'invalid-envelope' }
  | { code: 'untrusted-public-key' }
  | { code: 'stale-revision'; minimumRevision: number; actualRevision: number }
  | { code: 'invalid-public-key' }
  | { code: 'invalid-signature' };

export type BundleVerificationResult =
  | { ok: true; manifest: BundleManifest }
  | { ok: false; failure: BundleVerificationFailure };

export type BundleAssetVerificationFailure =
  | { code: 'asset-not-listed'; path: string }
  | { code: 'byte-length-mismatch'; expected: number; actual: number }
  | { code: 'digest-mismatch' };

export type BundleAssetVerificationResult = { ok: true } | { ok: false; failure: BundleAssetVerificationFailure };

function decodeBase64Url(value: string): ArrayBuffer {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Verifies a strict envelope against a separately trusted key and revision floor. */
export async function verifySignedBundleManifest(
  value: unknown,
  trustedPublicKey: string,
  minimumRevision = 0,
): Promise<BundleVerificationResult> {
  if (!isSignedBundleManifest(value)) return { ok: false, failure: { code: 'invalid-envelope' } };
  const signed: SignedBundleManifest = value;
  if (signed.publicKey !== trustedPublicKey) return { ok: false, failure: { code: 'untrusted-public-key' } };
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 0 || signed.manifest.revision < minimumRevision) {
    return {
      ok: false,
      failure: { code: 'stale-revision', minimumRevision, actualRevision: signed.manifest.revision },
    };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'spki',
      decodeBase64Url(trustedPublicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return { ok: false, failure: { code: 'invalid-public-key' } };
  }

  try {
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decodeBase64Url(signed.signature),
      new TextEncoder().encode(canonicalManifest(signed.manifest)),
    );
    return verified ? { ok: true, manifest: signed.manifest } : { ok: false, failure: { code: 'invalid-signature' } };
  } catch {
    return { ok: false, failure: { code: 'invalid-signature' } };
  }
}

/** Verifies fetched raw response bytes against an authenticated manifest. */
export async function verifyBundleAsset(
  manifest: BundleManifest,
  assetPath: string,
  bytes: ArrayBuffer,
): Promise<BundleAssetVerificationResult> {
  const asset = assetFor(manifest, assetPath);
  if (asset === undefined) return { ok: false, failure: { code: 'asset-not-listed', path: assetPath } };
  if (bytes.byteLength !== asset.byteLength) {
    return {
      ok: false,
      failure: { code: 'byte-length-mismatch', expected: asset.byteLength, actual: bytes.byteLength },
    };
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  return digest === asset.sha256 ? { ok: true } : { ok: false, failure: { code: 'digest-mismatch' } };
}
