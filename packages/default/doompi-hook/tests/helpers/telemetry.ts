import type { HookTelemetry, HookTelemetryAttributes, HookTelemetryEventName } from '../../src/types/telemetry.ts';

export interface RecordedTelemetry {
  level: 'error' | 'warning';
  event: HookTelemetryEventName;
  attributes?: HookTelemetryAttributes;
}

export function recordingTelemetry(): { telemetry: HookTelemetry; records: RecordedTelemetry[] } {
  const records: RecordedTelemetry[] = [];
  return {
    records,
    telemetry: {
      recordError: async (event, _error, attributes) => {
        records.push({ level: 'error', event, attributes });
      },
      recordWarning: async (event, _error, attributes) => {
        records.push({ level: 'warning', event, attributes });
      },
    },
  };
}
