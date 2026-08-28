import type { DoomTraceContext } from '@agimon-ai/doompi-telemetry';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;

/** Accepts only a valid W3C traceparent and never forwards tracestate or baggage. */
export function validatedTraceContext(value: unknown): DoomTraceContext | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TRACEPARENT.exec(value);
  if (!match || /^0+$/u.test(match[1] ?? '') || /^0+$/u.test(match[2] ?? '')) return undefined;
  return { traceparent: value };
}
