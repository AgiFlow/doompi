export function initHelp(): string {
  return `Usage: doompi init [--force]

Fills missing files in ~/.pi/.doom and registers the DoomPi extension alias and
theme in Pi user settings.

Options:
  --force                   Replace the four personal .doom files with current
                            templates instead of only filling missing ones
  -h, --help                Show this help
`;
}
