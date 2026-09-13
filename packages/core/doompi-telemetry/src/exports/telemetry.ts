export {
  createDoomTelemetry,
  createTelemetryHeaders,
  sanitizeTelemetryAttributes,
  subscribeTelemetryRecords,
} from '../services/logSinkTelemetry';
export type {
  DoomTelemetry,
  DoomTelemetryAttributes,
  DoomTelemetryErrorOptions,
  DoomTelemetryEventLevel,
  DoomTelemetryOptions,
  DoomTelemetryRecord,
  DoomTelemetryStatus,
  DoomTraceContext,
} from '../types/telemetry';
