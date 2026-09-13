import type { DoomTelemetry, DoomTelemetryOptions, DoomTelemetryRuntime } from '../../types/telemetry';
import {
  createDoomTelemetryService,
  createTelemetryHeaders,
  sanitizeTelemetryAttributes,
  subscribeTelemetryRecords,
} from '../telemetry';

export type {
  DoomTelemetry,
  DoomTelemetryAttributes,
  DoomTelemetryErrorOptions,
  DoomTelemetryEventLevel,
  DoomTelemetryOptions,
  DoomTelemetryRecord,
  DoomTelemetryStatus,
  DoomTraceContext,
} from '../../types/telemetry';

let nodeTelemetryModule: Promise<typeof import('@agimon-ai/log-sink-mcp/telemetry/node')> | undefined;

async function loadNodeTelemetryRuntime(): Promise<DoomTelemetryRuntime> {
  nodeTelemetryModule ??= import('@agimon-ai/log-sink-mcp/telemetry/node');
  const module = await nodeTelemetryModule;
  return {
    createNodeTelemetry: module.createNodeTelemetry,
    resolveNodeTelemetryEndpoints: module.resolveNodeTelemetryEndpoints,
  };
}

export function createDoomTelemetry(options: DoomTelemetryOptions): DoomTelemetry {
  return createDoomTelemetryService(options, loadNodeTelemetryRuntime);
}

export { createTelemetryHeaders, sanitizeTelemetryAttributes, subscribeTelemetryRecords };
