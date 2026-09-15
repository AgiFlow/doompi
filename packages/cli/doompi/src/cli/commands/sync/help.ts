const SYNC_MATRIX_OPTIONS = `Matrix options:
  --major-mode <name>       Named major mode from .doom/modes.yaml
  --profile <name>          Persona and env from .doom/profiles.yaml
  --domains <names>         Comma-separated content domains
  --no-domains              Select no domains
`;

export function syncHelp(): string {
  return `Usage: doompi sync [matrix options] [--check] [--force]

Installs required packages, builds, resolves the composition, and publishes
synchronized state under ~/.pi/.doom/sync.

Unsupported keys in .doom/config.yaml and .doom/modes.yaml are reported and
ignored rather than treated as errors, so a config written for a different
version cannot break a build. Run doompi doctor for the strict check.

Options:
  --check                   Report drift and exit non-zero without writing
  --force                   Publish a new generation even without drift
  -h, --help                Show this help

${SYNC_MATRIX_OPTIONS}`;
}
