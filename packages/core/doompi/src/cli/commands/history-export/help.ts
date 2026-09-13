export function historyExportHelp(): string {
  return `Usage: doompi history-export <v4-source> <v3-destination> [options]

Exports one canonical v4 JSONL session to a distinct v3 JSONL file and writes a
machine-readable loss report. Existing destination, report, and state files are
never overwritten.

Options:
  --report <path>            Loss report path (default: <destination>.loss.json)
  --state <path>             Resumable export state path
  -h, --help                Show this help
`;
}
