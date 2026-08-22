import type { DomainManifest } from '../types/domains.ts';

const NAME_DELIMITER = ',';

/** Splits comma-joined selections and expands aliases into concrete domain names. */
export function expandDomainNames(manifest: DomainManifest, domainNames: readonly string[]): string[] {
  return domainNames
    .flatMap((raw) =>
      raw
        .split(NAME_DELIMITER)
        .map((name) => name.trim())
        .filter(Boolean),
    )
    .flatMap((name) => manifest.aliases[name] ?? [name]);
}

export function domainCompletionPrefix(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/^\/domains\s+(?:[^\s,]+,)*([^\s,]*)$/);
  return match?.[1];
}

export function domainCompletionItems(domainNames: string[], query: string): Array<{ value: string; label: string }> {
  const normalizedQuery = query.toLowerCase();
  return domainNames
    .filter((name) => name.toLowerCase().startsWith(normalizedQuery))
    .map((name) => ({ value: name, label: name }));
}
