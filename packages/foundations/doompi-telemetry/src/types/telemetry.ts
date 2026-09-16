import type {
  NodeTelemetryHandle,
  NodeTelemetryOptions,
  ResolvedNodeTelemetryEndpoints,
} from '@agimon-ai/log-sink-mcp/telemetry/node';

export type DoomTelemetryHandle = NodeTelemetryHandle;

export type DoomTelemetryEventLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type DoomTelemetryAttributes = Record<string, string | number | boolean>;

export interface DoomTelemetryRecord {
  event: string;
  level: DoomTelemetryEventLevel;
  attributes: DoomTelemetryAttributes;
}

export interface DoomTelemetryStatus {
  serviceName: string;
  packageName?: string;
  backend: NodeTelemetryHandle['backend'] | 'disabled';
  enabled: boolean;
  endpoint?: string;
  endpointSource: NodeTelemetryHandle['endpointSource'];
  traces: boolean;
  fileFallback: boolean;
}

export interface DoomTelemetryOptions {
  serviceName: string;
  packageName?: string;
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  enableTraces?: boolean;
  enableLogs?: boolean;
  allowFileFallback?: boolean;
  retryDelayMs?: number;
  telemetryFactory?: TelemetryFactory;
  endpointResolver?: EndpointResolver;
  warn?: (message: string) => void;
  onRecord?: (record: DoomTelemetryRecord) => void;
  onStatus?: (status: DoomTelemetryStatus) => void;
}

export interface DoomTelemetryErrorOptions {
  /** Export the error as an OTEL exception. Callers must opt in because exception details can contain sensitive data. */
  includeException?: boolean;
}

export interface DoomTraceContext {
  traceparent: string;
}

export interface DoomTelemetry {
  recordDebug(event: string, attributes?: Record<string, unknown>): Promise<void>;
  recordEvent(event: string, attributes?: Record<string, unknown>): Promise<void>;
  recordWarning(event: string, error?: unknown, attributes?: Record<string, unknown>): Promise<void>;
  recordError(
    event: string,
    error?: unknown,
    attributes?: Record<string, unknown>,
    options?: DoomTelemetryErrorOptions,
  ): Promise<void>;
  runInSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    callback: (context?: DoomTraceContext) => Promise<T> | T,
    parent?: DoomTraceContext,
  ): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  status(): DoomTelemetryStatus;
}

export type TelemetryFactory = (options: NodeTelemetryOptions) => Promise<NodeTelemetryHandle>;
export type EndpointResolver = (options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageName?: string;
  serviceName?: string;
  workspaceRoot?: string;
  discoverEndpoint?: boolean;
  healthCheck?: boolean;
}) => Promise<ResolvedNodeTelemetryEndpoints>;

export interface DoomTelemetryRuntime {
  createNodeTelemetry: TelemetryFactory;
  resolveNodeTelemetryEndpoints: EndpointResolver;
}

export type DoomTelemetryRuntimeLoader = () => Promise<DoomTelemetryRuntime>;
