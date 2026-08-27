import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { Hono } from 'hono';
import {
  API_BASE_PATH,
  contentPath,
  currentPath,
  type PlanDetailView,
  type PlanSaveRequest,
  type PlanSaveView,
} from '../types/planApi.ts';
import type { PlanPointerPort } from '../types/planPointer.ts';
import { NodePlanPointerAdapter } from './node/planPointer.ts';

/**
 * This package's HTTP surface: the session's current plan, and the manual save.
 *
 * Routes are relative to the mount its host gives it, so nothing here repeats
 * where it was mounted. The host is one session's own server, which is what
 * makes the session id available without the page supplying it.
 *
 * Neither route takes a path. A session has exactly one current plan, and the
 * file both routes act on is the one the pointer names, so a page can address
 * the plan and nothing else; there is no traversal question to answer because
 * there is no path to traverse.
 *
 * The save refuses unless the reader proves they were looking at the content
 * that is still on disk. The agent may rewrite the plan while a tab is open,
 * and silently discarding whichever side finished second is the one outcome
 * worth ruling out.
 */

/** Past this, the plan is reported rather than carried. */
export const MAX_PLAN_BYTES = 1024 * 1024;

const NO_PLAN = 'This session has not written a plan yet.';
const STALE_SAVE = 'The plan changed since it was opened.';
const NOT_A_FILE = 'The plan file is no longer a regular file, so it was not written.';

export interface PlanApiOptions {
  /** The session these routes answer for; absent when the host is the hub. */
  sessionId?: string;
  pointers?: PlanPointerPort;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Reads the plan as the source view will show it, or says why it cannot. */
async function readPlan(
  planPath: string,
): Promise<Pick<PlanDetailView, 'content' | 'hash' | 'unavailable' | 'reason'>> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(planPath);
  } catch {
    return { content: '', hash: '', unavailable: true, reason: 'the plan file no longer exists' };
  }
  if (raw.byteLength > MAX_PLAN_BYTES) {
    return { content: '', hash: '', unavailable: true, reason: `the plan is larger than ${MAX_PLAN_BYTES} bytes` };
  }
  const content = raw.toString('utf8');
  return { content, hash: hashOf(content), unavailable: false };
}

export function createPlanApi(options: PlanApiOptions = {}): Hono {
  const app = new Hono();
  const pointers = options.pointers ?? new NodePlanPointerAdapter();
  const pointerFor = (): ReturnType<PlanPointerPort['read']> =>
    options.sessionId === undefined ? undefined : pointers.read(options.sessionId);

  app.get(currentPath(), async (context) => {
    const pointer = pointerFor();
    if (pointer === undefined) return context.json({ error: NO_PLAN }, 404);
    const view: PlanDetailView = {
      path: pointer.path,
      title: pointer.title,
      writtenAt: pointer.writtenAt,
      ...(pointer.planId === undefined ? {} : { planId: pointer.planId }),
      ...(await readPlan(pointer.path)),
    };
    return context.json(view);
  });

  app.put(contentPath(), async (context) => {
    let request: PlanSaveRequest;
    try {
      request = (await context.req.json()) as PlanSaveRequest;
    } catch {
      return context.json({ error: 'The save body is not JSON.' }, 400);
    }
    if (typeof request.content !== 'string' || typeof request.expectedHash !== 'string') {
      return context.json({ error: 'A save carries the content to write and the hash it was read at.' }, 400);
    }
    const pointer = pointerFor();
    if (pointer === undefined) return context.json({ error: NO_PLAN }, 404);

    const current = await readPlan(pointer.path);
    if (current.unavailable) return context.json({ error: current.reason ?? NO_PLAN }, 409);
    if (current.hash !== request.expectedHash) {
      return context.json({ error: STALE_SAVE, hash: current.hash }, 409);
    }
    // The same guard write_plan applies before it writes: a plan whose
    // destination has become a symlink or gained a second name is not written
    // through, whatever the pointer still says.
    const stats = await fs.lstat(pointer.path);
    if (!stats.isFile() || stats.nlink !== 1) return context.json({ error: NOT_A_FILE }, 409);

    await fs.writeFile(pointer.path, request.content, { encoding: 'utf8', mode: 0o600 });
    return context.json({ hash: hashOf(request.content) } satisfies PlanSaveView);
  });

  return app;
}

/** The named export a host imports from this package's built entry. */
export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    const app = createPlanApi(context.sessionId === undefined ? {} : { sessionId: context.sessionId });
    return {
      fetch: (request) => app.fetch(request),
      // Nothing outlives a request here; an API that starts a watch or a timer
      // tears it down in this callback.
      close: () => undefined,
    };
  },
};
