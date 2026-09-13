/**
 * Vocabulary for the on-disk session registry that the hub watches and every
 * session server writes into.
 *
 * Session lineage rides a sidecar file rather than the session record itself.
 * The record's schema is owned and written by the session server, so a package
 * that spawns a session has no way to add a field to it. A sidecar written
 * beside the record lets any spawning package declare where a session came
 * from without either side reaching into the other's format, and lets a reader
 * treat a missing or unreadable sidecar as "no parent" rather than an error.
 */

/** How a registry directory is chosen, most explicit source first. */
export interface RegistryDirInput {
  /** Value of --registry-dir, when given; wins over everything else. */
  readonly flagValue?: string;
  /** Value of DOOMPI_RUNTIME_DIR, when set. */
  readonly envValue?: string;
  /** The user's home directory, supplied by the host. */
  readonly homeDir: string;
}

/**
 * Where a session came from, written next to its registry record by whoever
 * spawned it. Absent for a session a person started themselves.
 */
export interface SessionLineageRecord {
  /** Bumped when this shape changes; a reader ignores any other value. */
  version: 1;
  /** The session this one was spawned from. */
  parentSessionId: string;
  /**
   * Short label in the spawning package's own vocabulary, such as "worktree".
   * Free text: the host never interprets it, it only carries it to the rail so
   * the rail can pick an affordance for it.
   */
  provenance: string;
}

/**
 * Where the cockpit hub is listening, published by the hub into the registry
 * directory so a local process can find it without guessing ports.
 *
 * This is deliberately the local listener only. The hub may also be reachable
 * through a tunnel, but that address is for people, not for processes on this
 * machine, and writing it here would turn a discovery file into a way to reach
 * a cockpit from somewhere its owner never authorised.
 *
 * Finding this file is not proof the hub is alive. It outlives a crash, so a
 * reader probes the address before trusting it.
 */
export interface HubAdvertisement {
  /** Bumped when this shape changes; a reader ignores any other value. */
  version: 1;
  /** Origin of the local listener, such as "http://127.0.0.1:4300". */
  url: string;
  /** The hub process, so a reader can tell a restart from a stale file. */
  pid: number;
}
