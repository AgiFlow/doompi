export const BUNDLE_ASSET_POLICY_PATH = '/bundle-asset-policy.json';
export const BUNDLE_ASSET_POLICY_VERSION = 1;

export interface BundleAssetPolicy {
  version: typeof BUNDLE_ASSET_POLICY_VERSION;
  optional: string[];
}

export function parseBundleAssetPolicy(value: unknown): BundleAssetPolicy | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !== 'optional,version' ||
    candidate.version !== BUNDLE_ASSET_POLICY_VERSION ||
    !Array.isArray(candidate.optional)
  ) {
    return undefined;
  }
  const optional = candidate.optional;
  if (
    optional.some(
      (asset) =>
        typeof asset !== 'string' ||
        !asset.startsWith('/') ||
        asset.includes('\\') ||
        asset.includes('?') ||
        asset.includes('#'),
    ) ||
    new Set(optional).size !== optional.length
  ) {
    return undefined;
  }
  return { version: BUNDLE_ASSET_POLICY_VERSION, optional: [...optional].sort((a, b) => a.localeCompare(b)) };
}
