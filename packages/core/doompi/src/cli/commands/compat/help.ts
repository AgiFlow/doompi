export const COMPATIBILITY_MATRIX_OPTIONS = `Compatibility matrix options:
  --profile <name>          Persona and env from .doom/profiles.yaml
  --domains <names>         Comma-separated content domains
  --major-mode <name>       Named major mode from .doom/modes.yaml
  --skip-permissions        Disable the launched frontend's approval prompts
                            for this run. Off by default; the run warns when on.
  --                        Pass following matrix-named flags to the provider
`;

export function compatHelp(): string {
  return `Usage: doompi compat <codex|claude|antigravity> [matrix options] [provider arguments]

Resolves the DoomPi matrix and launches the named compatibility frontend.

${COMPATIBILITY_MATRIX_OPTIONS}
Options:
  -h, --help                Show this help

All other compatibility arguments pass to the provider unchanged.
`;
}
