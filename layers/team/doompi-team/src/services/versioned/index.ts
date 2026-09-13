/**
 * Version envelope shared by every artifact this package writes to disk.
 *
 * DESIGN PATTERNS:
 * - Every record carries `version` from the day it is created, so a later format
 *   change can be detected rather than guessed at
 * - Readers reject an unknown version instead of coercing it: a run directory
 *   written by a newer build is skipped, not misread
 *
 * WHY THIS EXISTS:
 * Several predecessor artifacts had no version field at all, which left no way
 * to change their shape without a silent misparse in a mixed-version session.
 *
 * AVOID:
 * - Bumping a version to add an optional field; additive changes stay compatible
 * - Reading a record without going through `parseVersioned`
 */

export interface VersionedRecord {
  version: number;
}

export type VersionedParseFailure =
  | { reason: 'not-an-object' }
  | { reason: 'missing-version' }
  | { reason: 'unsupported-version'; found: number };

export type VersionedParseResult<T> = { ok: true; value: T } | { ok: false; failure: VersionedParseFailure };

/**
 * Validate that `value` is an object carrying one of `supportedVersions`.
 *
 * Returns a result rather than throwing because most callers are scanning a
 * directory and want to skip a bad record, not abort the sweep.
 */
export function parseVersioned<T extends VersionedRecord>(
  value: unknown,
  supportedVersions: readonly number[],
): VersionedParseResult<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: { reason: 'not-an-object' } };
  }
  const found = (value as Partial<VersionedRecord>).version;
  if (typeof found !== 'number' || !Number.isInteger(found)) {
    return { ok: false, failure: { reason: 'missing-version' } };
  }
  if (!supportedVersions.includes(found)) {
    return { ok: false, failure: { reason: 'unsupported-version', found } };
  }
  return { ok: true, value: value as T };
}

/** Human-readable explanation for a rejected record, for logs and diagnostics. */
export function describeVersionedFailure(failure: VersionedParseFailure, label: string): string {
  switch (failure.reason) {
    case 'not-an-object':
      return `${label} is not an object.`;
    case 'missing-version':
      return `${label} has no integer version field.`;
    case 'unsupported-version':
      return `${label} has unsupported version ${failure.found}.`;
  }
}
