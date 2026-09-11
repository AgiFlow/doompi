/**
 * The contract between the trusted verifier worker and an open cockpit page.
 *
 * The worker owns bundle trust and the page owns what the person sees, so the
 * only thing that crosses is a statement of fact: a newer revision is verified
 * and committed. The page decides what to do about it.
 */

export const BUNDLE_UPDATED_MESSAGE = 'doompi:bundle-updated';

export interface BundleUpdatedMessage {
  type: typeof BUNDLE_UPDATED_MESSAGE;
  revision: number;
}

/**
 * Reads a worker message, or undefined when it is anything else.
 *
 * A page listens on one message channel for every worker it hosts, so an
 * unrecognised shape is ordinary traffic rather than an error.
 */
export function parseBundleUpdatedMessage(value: unknown): BundleUpdatedMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== BUNDLE_UPDATED_MESSAGE) return undefined;
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) return undefined;
  return { type: BUNDLE_UPDATED_MESSAGE, revision: Number(record.revision) };
}
