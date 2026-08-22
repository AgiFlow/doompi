import { describe, expect, it } from 'vitest';
import { PromptCacheTelemetry } from '../../../src/services/telemetry.ts';

describe('provider-observed cache telemetry', () => {
  it('records bounded provider usage for the pending namespace and model', () => {
    const telemetry = new PromptCacheTelemetry(2);
    telemetry.observe({ cacheRead: 1, cacheWrite: 2, totalInput: 3 }, 1);
    expect(telemetry.snapshot().observations).toEqual([]);

    telemetry.beginRequest({
      capability: 'key-and-long-retention',
      namespace: 'dpn1_parent',
      modelFingerprint: 'dpm1_model',
      requestedRetention: '24h',
      keySuffix: '12345678',
    });
    telemetry.observe({ cacheRead: 10, cacheWrite: 20, totalInput: 100 }, 1000);
    telemetry.observe({ cacheRead: 30, cacheWrite: 0, totalInput: 120 }, 2000);
    telemetry.observe({ cacheRead: 40, cacheWrite: 0, totalInput: 140 }, 3000);

    const snapshot = telemetry.snapshot();
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations.map(({ cacheRead }) => cacheRead)).toEqual([30, 40]);
    expect(snapshot.lastObservation?.observedAt).toBe(3000);
    expect(snapshot.residency).toBe('unknown');
  });

  it('reports observations without claiming current provider residency', () => {
    const telemetry = new PromptCacheTelemetry();
    telemetry.beginRequest({
      capability: 'marker-only',
      namespace: 'dpn1_parent',
      modelFingerprint: 'dpm1_model',
    });
    telemetry.observe({ cacheRead: 512, cacheWrite: 128, totalInput: 1024 }, 1000);

    const snapshot = telemetry.snapshot();
    expect(snapshot.lastObservation).toMatchObject({ cacheRead: 512, cacheWrite: 128, totalInput: 1024 });
    expect(snapshot.residency).toBe('unknown');
  });

  it('clears process-local observations on reset', () => {
    const telemetry = new PromptCacheTelemetry();
    telemetry.beginRequest({ capability: 'automatic', namespace: 'namespace', modelFingerprint: 'model' });
    telemetry.observe({ cacheRead: 1, cacheWrite: 0, totalInput: 1 }, 1);
    telemetry.reset();
    expect(telemetry.snapshot()).toMatchObject({ capability: 'unknown', observations: [], residency: 'unknown' });
  });
});
