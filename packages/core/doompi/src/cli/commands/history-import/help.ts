export function historyImportHelp(): string {
  return `Usage: doompi history-import <v3-source> <v4-destination> --confirm-offline
       doompi history-import <jsonl-source> <sqlite-destination> --format sqlite --confirm-offline

Preserves the original JSONL and imports a separate canonical copy. Use --format
sqlite for server roots and native server children. Terminal sessions use JSONL. Stop Pi
before running this command. The confirmation flag cannot prove that an unmanaged
Pi process has stopped, and stale ownership locks are never reclaimed automatically.

Options:
  --format sqlite           Import v3 or v4 JSONL into a server SQLite database
  --confirm-offline          Confirm Pi is stopped and authorize the offline import
  -h, --help                Show this help
`;
}
