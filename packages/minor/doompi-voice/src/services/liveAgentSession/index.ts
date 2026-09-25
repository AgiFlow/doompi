import { randomUUID } from 'node:crypto';

import type { LiveAgentResult } from '../globalLiveCompanion/type';

interface Route {
  activationId: string;
  routeGeneration: number;
  transactionId: string;
}

interface Run {
  requestId: string;
  route: Route;
  turnId?: string;
  assistantText?: string;
  status: 'completed' | 'aborted' | 'failed';
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\w.:-]+$/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const reject = (message: string, status = 409): Response => Response.json({ error: message }, { status });

/** The only native-agent boundary for the host-global live companion. */
export class LiveAgentSession {
  public readonly sessionIncarnation = randomUUID();
  private route: Route | undefined;
  private readonly pending: Array<{ requestId: string; route: Route }> = [];
  private readonly runs = new Map<string, Run>();
  private readonly events: LiveAgentResult[] = [];
  private nextSequence = 0;
  private closed = false;

  public constructor(
    private readonly sessionId: string,
    private readonly hubToken: string | undefined,
    private readonly admitPrompt: (text: string) => Promise<void>,
  ) {}

  public onRunStart(value: unknown): void {
    const runId = record(value)?.runId;
    if (!validId(runId) || this.closed || this.runs.has(runId)) return;
    const next = this.pending.shift();
    if (next && this.route === next.route)
      this.runs.set(runId, { requestId: next.requestId, route: next.route, status: 'failed' });
  }

  public onTurnEnd(value: unknown): void {
    const turn = record(value);
    const run = this.runs.get(String(turn?.runId));
    const message = record(turn?.message);
    if (!run || this.route !== run.route || message?.role !== 'assistant' || message.stopReason === 'toolUse') return;
    const parts = message.content;
    run.turnId = validId(turn?.turnId) ? turn.turnId : undefined;
    run.status = message.stopReason === 'stop' ? 'completed' : message.stopReason === 'aborted' ? 'aborted' : 'failed';
    run.assistantText = Array.isArray(parts)
      ? parts
          .map((part: unknown) => record(part))
          .filter((part) => part?.type === 'text')
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('')
      : undefined;
  }

  public onSettled(value: unknown): void {
    const runId = record(value)?.runId;
    if (typeof runId !== 'string') return;
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    if (this.route !== run.route) return;
    this.events.push({
      sequence: ++this.nextSequence,
      requestIds: [run.requestId],
      runId,
      ...(run.turnId ? { turnId: run.turnId } : {}),
      resultId: `${this.sessionIncarnation}:${runId}:${run.turnId ?? 'final'}`,
      ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
      status: run.status,
      sourceSessionId: this.sessionId,
      sessionIncarnation: this.sessionIncarnation,
    });
  }

  public close(): void {
    this.closed = true;
    this.route = undefined;
    this.pending.length = 0;
    this.runs.clear();
    this.events.length = 0;
  }

  public async fetch(request: Request): Promise<Response> {
    if (!this.hubToken || request.headers.get('authorization') !== `Bearer ${this.hubToken}`)
      return reject('Not found.', 404);
    if (this.closed) return reject('Pi agent session is closed.', 503);
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/live/agent')
      return Response.json({
        available: true,
        sourceSessionId: this.sessionId,
        sessionIncarnation: this.sessionIncarnation,
      });
    const body = request.method === 'POST' ? record(await request.json().catch(() => undefined)) : undefined;
    if (request.method === 'POST' && path === '/live/agent/prepare') {
      if (
        !validId(body?.activationId) ||
        !Number.isSafeInteger(body?.routeGeneration) ||
        (body?.routeGeneration as number) < 1 ||
        !validId(body?.transactionId)
      )
        return reject('Invalid live agent route.', 400);
      if (this.pending.length || this.runs.size || this.events.length)
        return reject('The Pi agent still has live Voice work.');
      this.route = {
        activationId: body.activationId,
        routeGeneration: body.routeGeneration as number,
        transactionId: body.transactionId,
      };
      return Response.json({
        sourceSessionId: this.sessionId,
        sessionIncarnation: this.sessionIncarnation,
        routeGeneration: this.route.routeGeneration,
      });
    }
    const route = this.route;
    const requested = request.method === 'GET' ? Object.fromEntries(url.searchParams) : body;
    if (
      !route ||
      requested?.activationId !== route.activationId ||
      Number(requested.routeGeneration) !== route.routeGeneration ||
      requested.sessionIncarnation !== this.sessionIncarnation
    )
      return reject('The live Pi agent route is stale.');
    if (request.method === 'POST' && path === '/live/agent/admit') {
      const requestId = body?.requestId;
      const transcript = body?.transcript;
      if (
        !validId(requestId) ||
        typeof transcript !== 'string' ||
        !transcript.trim() ||
        Buffer.byteLength(transcript, 'utf8') > 16 * 1024 ||
        body?.intent !== 'immediate'
      )
        return reject('Invalid live Voice request.', 400);
      if (this.pending.length + this.runs.size + this.events.length >= 128)
        return reject('Live Voice results must be acknowledged before new admission.');
      if (
        this.pending.some((item) => item.requestId === requestId) ||
        [...this.runs.values()].some((item) => item.requestId === requestId) ||
        this.events.some((event) => event.requestIds.includes(requestId))
      )
        return reject('Live Voice request already admitted.');
      const item = { requestId, route };
      this.pending.push(item);
      try {
        await this.admitPrompt(transcript);
        return Response.json({ admitted: true, requestId });
      } catch {
        const index = this.pending.indexOf(item);
        if (index !== -1) this.pending.splice(index, 1);
        return reject('Native Pi admission is uncertain.', 503);
      }
    }
    if (request.method === 'GET' && path === '/live/agent/results') {
      const after = Number(url.searchParams.get('after'));
      if (!Number.isSafeInteger(after) || after < 0 || after > this.nextSequence)
        return reject('Invalid result cursor.', 400);
      return Response.json({
        cursor: this.nextSequence,
        activeRuns: [
          ...this.pending.map((item) => ({ runId: `pending:${item.requestId}` })),
          ...[...this.runs.keys()].map((runId) => ({ runId })),
        ],
        events: this.events.filter((event) => event.sequence > after),
      });
    }
    if (request.method === 'POST' && path === '/live/agent/results/ack') {
      const cursor = body?.cursor;
      if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor > this.nextSequence || cursor < 0)
        return reject('Invalid result acknowledgement.', 400);
      while (this.events[0] && this.events[0].sequence <= cursor) this.events.shift();
      return new Response(null, { status: 204 });
    }
    if (request.method === 'POST' && path === '/live/agent/fence') {
      if (body?.transactionId !== route.transactionId || this.pending.length || this.runs.size || this.events.length)
        return reject('The source Pi agent has not drained.');
      this.route = undefined;
      return new Response(null, { status: 204 });
    }
    return reject('Not found.', 404);
  }
}
