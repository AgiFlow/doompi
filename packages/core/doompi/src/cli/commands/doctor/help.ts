export function doctorHelp(): string {
  return `Usage: doompi doctor

Checks the DoomPi installation and reports what is wrong without changing
anything. Validates .doom/config.yaml and .doom/modes.yaml strictly, including
the unsupported keys doompi sync ignores, then reports everything
doompi sync --check reports.

Exits non-zero when any check fails.

Options:
  -h, --help                Show this help
`;
}
