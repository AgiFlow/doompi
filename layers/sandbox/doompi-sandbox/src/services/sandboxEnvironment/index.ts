const EXACT_NAMES = new Set([
  'TERM',
  'COLORTERM',
  'LANG',
  'TZ',
  'DOOMPI_PRESET',
  'ELICITATION_SESSION_ID',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);
const NAME_PREFIXES = ['LC_'];
const NAME_SUFFIXES = ['_API_KEY', '_AUTH_TOKEN', '_BASE_URL'];

/** True for variables shaped like a provider credential or endpoint override. */
export function isCredentialEnvName(name: string): boolean {
  return NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function allowed(name: string): boolean {
  return (
    EXACT_NAMES.has(name) ||
    NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/**
 * Projects the host environment down to what a sandboxed session may see.
 *
 * The list is an allowlist on purpose: everything a terminal accumulates
 * (agents, sockets, tokens, paths) stays on the host unless a rule names it.
 * Provider credentials pass through for now; the credential broker planned for
 * the client-server phase removes even those from the container.
 */
export function filterSandboxEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && allowed(name)) filtered[name] = value;
  }
  return filtered;
}
