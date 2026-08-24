/** Format version stamped on every record so readers can skip ones they do not understand. */
export const SESSION_RECORD_VERSION = 1;

/**
 * One running doompi-server, announced by a JSON file in the registry directory.
 *
 * Writing the record is the whole act of registration: there is no daemon to
 * call and no lock to take. The record carries a token file path rather than
 * the token itself, so the secret lives in exactly one owner-only file.
 *
 * The same shape is declared in @agimon-ai/doompi-web, which reads the records;
 * a contract test keeps the two declarations assignable both ways.
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
