import { describe, expect, it, vi } from 'vitest';
import { observe } from '../../../../src/services/serverTelemetry';
import { validatedTraceContext } from '../../../../src/services/traceContext';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('server trace propagation', () => {
  it('accepts only valid, nonzero W3C trace parents', () => {
    expect(validatedTraceContext(VALID)).toEqual({ traceparent: VALID });
    expect(validatedTraceContext(undefined)).toBeUndefined();
    expect(validatedTraceContext('not-a-trace')).toBeUndefined();
    expect(validatedTraceContext('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(validatedTraceContext('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeUndefined();
  });

  it('contains rejected background telemetry operations', async () => {
    const notice = vi.fn();
    observe(Promise.reject(new Error('offline')), notice);
    await new Promise((resolve) => setImmediate(resolve));
    expect(notice).toHaveBeenCalledWith('telemetry failed: offline');
  });
});
