import type { WorkflowTerminalCapabilitiesView } from '../types/webWorkflowTerminal.ts';

/**
 * One run's terminal, shared by every surface watching it.
 *
 * WHY COALESCING LIVES HERE:
 * Reading a multiplexer's screen forks a CLI, measured at roughly 75ms a call.
 * Several readers on one run (a step tab, a second browser, the session's own
 * panel) would otherwise each fork on their own timer, and a read that runs
 * long would have the next one start on top of it, unbounded. One read per run
 * at a time, no faster than the interval, however many surfaces are watching.
 *
 * WHY A CONTROL LEASE:
 * A run's terminal takes keystrokes from anyone who can reach it, so two
 * readers typing into one nested agent is a real state, not a hypothetical.
 * The lease does not make it impossible, since the session's own panel can
 * still type; it makes it visible, and keeps two cockpit tabs from fighting.
 */

/** The engine's terminal facade, as this service needs it. */
export interface TerminalPort<Record> {
  capabilities(record: Record): WorkflowTerminalCapabilitiesView;
  screen(record: Record, options: { lines?: number }): Promise<string[]>;
  write(record: Record, data: string): Promise<void>;
  resize(record: Record, columns: number, rows: number): Promise<boolean>;
}

export interface WorkflowTerminalDeps<Record> {
  terminal: TerminalPort<Record>;
  /** Injected so the cadence and the lease clock are assertable. */
  now: () => number;
  /** Shortest gap between two reads of one run. */
  refreshMs?: number;
  /** How long a keyboard lease survives without being renewed. */
  leaseMs?: number;
}

/** A read in flight, and what the last one returned. */
interface ScreenEntry {
  /**
   * When the last read finished, absent until one has.
   *
   * Absent rather than zero: zero is a real instant, and a service whose clock
   * starts near it would answer the very first read from an empty cache and
   * paint nothing until the interval had passed.
   */
  at?: number;
  lines: string[];
  inFlight?: Promise<string[]>;
}

interface Lease {
  token: string;
  expiresAt: number;
}

const DEFAULT_REFRESH_MS = 750;
const DEFAULT_LEASE_MS = 60_000;
const NOT_HELD = 'Another reader holds the keyboard for this run.';

export interface WorkflowTerminalService<Record> {
  /** The run's recent screen, reusing a recent read rather than forking again. */
  screen(identity: string, record: Record, lines: number): Promise<string[]>;
  capabilities(record: Record): WorkflowTerminalCapabilitiesView;
  /** Takes the keyboard, or reports who has it. Renews when the holder asks again. */
  takeControl(identity: string, token: string): boolean;
  releaseControl(identity: string, token: string): void;
  /** Writes on behalf of a lease holder; throws when the lease is not theirs. */
  write(identity: string, record: Record, token: string, data: string): Promise<void>;
  /**
   * Matches the run's terminal to the holder's viewport.
   *
   * Behind the same lease as writing: geometry is shared by everyone watching,
   * so a passive reader must not reflow the screen under the person typing.
   */
  resize(identity: string, record: Record, token: string, columns: number, rows: number): Promise<boolean>;
  /** Drops what is remembered for runs that can never change again. */
  forget(live: ReadonlySet<string>): void;
}

export function createWorkflowTerminalService<Record>(
  deps: WorkflowTerminalDeps<Record>,
): WorkflowTerminalService<Record> {
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const screens = new Map<string, ScreenEntry>();
  const leases = new Map<string, Lease>();

  const heldBy = (identity: string): Lease | undefined => {
    const lease = leases.get(identity);
    if (lease === undefined) return undefined;
    if (lease.expiresAt > deps.now()) return lease;
    leases.delete(identity);
    return undefined;
  };

  return {
    async screen(identity, record, lines) {
      const entry = screens.get(identity) ?? { lines: [] };
      screens.set(identity, entry);
      if (entry.inFlight) return entry.lines;
      if (entry.at !== undefined && deps.now() - entry.at < refreshMs) return entry.lines;
      entry.inFlight = deps.terminal.screen(record, { lines });
      try {
        entry.lines = await entry.inFlight;
      } finally {
        // Stamped after the read, not before: the interval is a gap between
        // reads, so a slow scrape must not immediately earn another one.
        entry.at = deps.now();
        entry.inFlight = undefined;
      }
      return entry.lines;
    },
    capabilities(record) {
      return deps.terminal.capabilities(record);
    },
    takeControl(identity, token) {
      const holder = heldBy(identity);
      if (holder !== undefined && holder.token !== token) return false;
      leases.set(identity, { token, expiresAt: deps.now() + leaseMs });
      return true;
    },
    releaseControl(identity, token) {
      if (heldBy(identity)?.token === token) leases.delete(identity);
    },
    async write(identity, record, token, data) {
      const holder = heldBy(identity);
      if (holder === undefined || holder.token !== token) throw new Error(NOT_HELD);
      leases.set(identity, { token, expiresAt: deps.now() + leaseMs });
      await deps.terminal.write(record, data);
    },
    async resize(identity, record, token, columns, rows) {
      const holder = heldBy(identity);
      if (holder === undefined || holder.token !== token) throw new Error(NOT_HELD);
      return deps.terminal.resize(record, columns, rows);
    },
    forget(live) {
      for (const identity of screens.keys()) {
        if (!live.has(identity)) screens.delete(identity);
      }
      for (const identity of leases.keys()) {
        if (!live.has(identity)) leases.delete(identity);
      }
    },
  };
}
