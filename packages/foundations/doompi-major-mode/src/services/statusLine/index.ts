import type { Theme } from '@earendil-works/pi-coding-agent';

export const STATUS_KEY = 'doom-major-mode';

/** Compact footer text for the selected major mode, domains, and profile. */
export function statusText(majorMode: string, domains: readonly string[], profile?: string): string {
  return [profile ? `*${profile}*` : undefined, `[${majorMode}]`, domains.join(',')]
    .filter((part) => Boolean(part))
    .join(':');
}

/**
 * The same footer, coloured.
 *
 * A pure function of the theme it is handed rather than of an ambient one, so it
 * stays testable with a plain object and lives beside statusText rather than in
 * the TUI layer the command may not reach.
 */
export function colorStatus(
  theme: Theme,
  majorMode: string,
  domains: readonly string[],
  profile: string | undefined,
  pending: boolean,
): string {
  const parts = [
    profile ? theme.fg('success', theme.bold(`*${profile}*`)) : undefined,
    theme.fg(pending ? 'warning' : 'accent', `[${majorMode}]`),
    domains.length > 0 ? theme.fg('muted', domains.join(',')) : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(theme.fg('dim', ':'));
}
