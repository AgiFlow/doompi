import type { PlanPointerRecord } from './planApi.ts';

/**
 * Record and read where write_plan left this session's plan file.
 *
 * write_plan resolves the plans directory against the harness root and names
 * the file after the plan's title and id. The session's API server is a
 * different process holding neither fact, and the plan's own filename says
 * nothing about which session owns it, so the two meet on a small record keyed
 * by the session: the extension writes it when the plan lands, the API reads
 * it and serves the path it names.
 *
 * Declared here, not beside its implementation: services may import types but
 * never adapters, so a port living in src/adapters would be unreachable from
 * the code that needs it.
 */
export interface PlanPointerPort {
  /** The session's plan, or undefined when it has written none. */
  read(sessionId: string): PlanPointerRecord | undefined;
  /** Records where the plan landed; a rewrite overwrites the record. */
  write(sessionId: string, record: PlanPointerRecord): void;
  /** Forgets the session's plan; forgetting one that was never written is not an error. */
  clear(sessionId: string): void;
}
