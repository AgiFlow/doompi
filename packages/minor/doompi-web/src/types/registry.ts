/** Format version stamped on every record so readers can skip ones they do not understand. */
export const SESSION_RECORD_VERSION = 1;

/**
 * One running doompi-server, announced by a JSON file in the registry directory.
 *
 * The authoritative writer is @agimon-ai/doompi-server; this package only reads
 * records. The shape is declared in both packages, mirroring the duplicated
 * framing helpers, and a contract test in doompi-server keeps the two
 * declarations assignable both ways.
 */
export interface SessionRecord {
  version: typeof SESSION_RECORD_VERSION;
  /** Pi session id, minted by the server (or passed via --session-id). */
  id: string;
  name: string;
  /** Absolute working directory of the supervised agent. */
  cwd: string;
  /** Absolute path of the session's unix socket. */
  socketPath: string;
  /** Absolute path of the file holding the attach token. */
  tokenFile: string;
  /** Server pid; a reader treats a dead pid as a stale record. */
  pid: number;
  /** ISO 8601 timestamp of registration. */
  createdAt: string;
}
