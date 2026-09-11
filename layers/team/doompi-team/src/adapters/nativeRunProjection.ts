import type { NativeAsyncJobProjection } from './asyncJobTracker';

export type NativeRunProjectionListener = (runs: readonly NativeAsyncJobProjection[]) => void;

export interface NativeRunProjectionSink {
  publish(sessionId: string, projection: NativeAsyncJobProjection): void;
  dispose(sessionId: string): void;
}

interface SessionProjection {
  readonly runs: Map<string, NativeAsyncJobProjection>;
  readonly listeners: Set<NativeRunProjectionListener>;
}

const sessions = new Map<string, SessionProjection>();

function projectionFor(sessionId: string): SessionProjection {
  let projection = sessions.get(sessionId);
  if (!projection) {
    projection = { runs: new Map(), listeners: new Set() };
    sessions.set(sessionId, projection);
  }
  return projection;
}

function snapshot(projection: SessionProjection): readonly NativeAsyncJobProjection[] {
  return [...projection.runs.values()];
}

export const nativeRunProjection: NativeRunProjectionSink = {
  publish(sessionId, run) {
    const projection = projectionFor(sessionId);
    projection.runs.set(run.runId, run);
    const runs = snapshot(projection);
    for (const listener of projection.listeners) listener(runs);
  },
  dispose(sessionId) {
    const projection = sessions.get(sessionId);
    if (!projection) return;
    for (const listener of projection.listeners) listener([]);
    projection.listeners.clear();
    projection.runs.clear();
    sessions.delete(sessionId);
  },
};

export function subscribeNativeRunProjection(sessionId: string, listener: NativeRunProjectionListener): () => void {
  const projection = projectionFor(sessionId);
  projection.listeners.add(listener);
  if (projection.runs.size > 0) listener(snapshot(projection));

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    projection.listeners.delete(listener);
    if (projection.listeners.size === 0 && projection.runs.size === 0) sessions.delete(sessionId);
  };
}
