/** Format version stamped on every record so readers can skip ones they do not understand. */
export const SESSION_RECORD_VERSION = 1;

/**
 * One running doompi-server, announced by a JSON file in the registry directory.
 *
 * Writing the record is the whole act of registration: there is no daemon to
 * call and no lock to take. The record carries a token file path rather than
 * the token itself, so the secret lives in exactly one owner-only file.
 *
 * The shape is exported for clients that read the registry. The server remains
 * its authoritative owner and writer.
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
  /**
   * Absolute path of the socket this session serves its package APIs on, when
   * any package declared one. Absent means no API is mounted, which a reader
   * answers rather than waits on.
   */
  apiSocketPath?: string;
  /**
   * Socket speaking Pi's own protocol, for clients that use PiClient.
   *
   * Absent on a server too old to serve one, so a client falls back to the
   * framed session socket rather than failing to attach.
   */
  protocolSocketPath?: string;
  /** Server pid; a reader treats a dead pid as a stale record. */
  pid: number;
  /** ISO 8601 timestamp of registration. */
  createdAt: string;
}
