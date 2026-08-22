export {
  createDoomTelemetry,
  createTelemetryHeaders,
  sanitizeTelemetryAttributes,
  subscribeTelemetryRecords,
} from '../adapters/logSinkTelemetry.js';
export type {
  DoomTelemetry,
  DoomTelemetryAttributes,
  DoomTelemetryErrorOptions,
  DoomTelemetryEventLevel,
  DoomTelemetryOptions,
  DoomTelemetryRecord,
  DoomTelemetryStatus,
} from '../types/telemetry.js';
