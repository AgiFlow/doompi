import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanPointerRecord } from '../../types/planApi.ts';
import type { PlanPointerPort } from '../../types/planPointer.ts';

/**
 * Record and read where write_plan left this session's plan file.
 *
 * One technology per adapter. This is where node enters the package; the
 * services that depend on the capability keep importing the port.
 *
 * Pi already gives every session an agent directory, so the records live under
 * it rather than in a second place a reader would have to know about. The
 * posture matches the plan file itself, 0700 on the directory and 0600 on the
 * record: a plan is a private working document, not something to leave
 * world-readable in a shared home.
 */

const POINTER_DIRECTORY = 'doom-plan';
const AGENT_DIRECTORY = ['.pi', 'agent'];
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface NodePlanPointerOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NodePlanPointerAdapter implements PlanPointerPort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;

  constructor(options: NodePlanPointerOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
  }

  /** Where the records live; exposed so a test can look without guessing. */
  directory(): string {
    const agentDirectory = this.env.PI_CODING_AGENT_DIR || path.join(this.homeDirectory, ...AGENT_DIRECTORY);
    return path.join(agentDirectory, POINTER_DIRECTORY);
  }

  /**
   * The record for one session. The id is hashed rather than used as written:
   * it reaches here from a host that may word it however it likes, and a
   * filename is not the place to find that out.
   */
  pathFor(sessionId: string): string {
    return path.join(this.directory(), `${this.hash(sessionId)}.json`);
  }

  read(sessionId: string): PlanPointerRecord | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathFor(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const { path: planPath, title, writtenAt, planId } = parsed;
    // A record half-written by an interrupted run reads as no plan at all,
    // which is a state the cockpit already handles.
    if (typeof planPath !== 'string' || !path.isAbsolute(planPath)) return undefined;
    if (typeof title !== 'string' || typeof writtenAt !== 'string') return undefined;
    return { path: planPath, title, writtenAt, ...(typeof planId === 'string' ? { planId } : {}) };
  }

  write(sessionId: string, record: PlanPointerRecord): void {
    fs.mkdirSync(this.directory(), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.writeFileSync(this.pathFor(sessionId), JSON.stringify(record), { mode: PRIVATE_FILE_MODE });
  }

  clear(sessionId: string): void {
    fs.rmSync(this.pathFor(sessionId), { force: true });
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}
