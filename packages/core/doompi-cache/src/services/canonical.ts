export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | CanonicalObject;

export interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Prompt cache identity cannot contain a non-finite number.');
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalValue(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return canonicalNumber(value);
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value !== 'object') throw new Error(`Unsupported prompt cache identity value: ${typeof value}.`);

  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    const entry = record[key];
    if (entry !== undefined) result[key.normalize('NFC')] = canonicalValue(entry);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
