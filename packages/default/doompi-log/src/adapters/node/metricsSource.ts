/**
 * Historical metrics access for the `SPC h l` overlay.
 *
 * Two transports, in order: the running sink's HTTP API, then the installed
 * CLI as a subprocess. The sink daemon is long-lived and often lags the
 * installed package, so a daemon that rejects newer query parameters is treated
 * as unavailable rather than fatal. The reader exported by log-sink-mcp is
 * deliberately not used in-process: better-sqlite3 is synchronous and a
 * one-day window blocks for seconds, which would freeze the TUI.
 *
 * Both transports resolve the sink instance from the same identity the Pi
 * telemetry extension writes under. Without it log-sink falls back to
 * `npm_package_name`, which a running Pi process does not set, so the reader
 * would land on the local instance while the writer exported to the global one
 * and the panel would report an empty history that no session ever filled.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { LogMetricsReport } from '@agimon-ai/log-sink-mcp';
import { resolveLogSinkInstance, resolveLogSinkPort } from '@agimon-ai/log-sink-mcp';
import type {
  MetricsInstance,
  MetricsQueryParams,
  MetricsSource,
  MetricsTransport,
} from '../../types/metricsSource.ts';

const PACKAGE_NAME = '@agimon-ai/log-sink-mcp';
const HTTP_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 30000;
/** A day of dev telemetry is already ~140k records; keep the payload bounded. */
const MAX_CLI_BUFFER = 32 * 1024 * 1024;
/**
 * The overlay ranks one tool, but a page pairing tool calls against failure
 * counts needs a denominator for every tool that failed, so callers ask.
 */
const DEFAULT_TOOL_LIMIT = 1;
/** The panel ranks consumers, so ask for the biggest rather than the most recent. */
const TOKEN_SORT = 'total-tokens';

/** The identity both transports resolve their sink instance from. */
interface ResolveIdentity {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  packageName?: string;
  serviceName?: string;
}

export interface MetricsSourceOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Identity the sink is registered under; must match the telemetry writer's. */
  packageName?: string;
  serviceName?: string;
  /** Overrides transport discovery in tests. */
  fetchImpl?: typeof fetch;
  cliRunner?: (params: MetricsQueryParams) => Promise<LogMetricsReport>;
}

function cliEntryPoint(): string {
  const require = createRequire(import.meta.url);
  // The published bin is CJS; the ESM build sits beside it and starts faster.
  const packageJson = require.resolve(`${PACKAGE_NAME}/package.json`);
  return path.join(path.dirname(packageJson), 'dist', 'cli.mjs');
}

/**
 * The sink names these the same way on the wire and on the command line, apart
 * from the case convention, so the two transports stay in step.
 */
const FILTER_QUERY_KEYS = {
  sessionId: 'sessionId',
  agentName: 'agentName',
  model: 'model',
  provider: 'provider',
} as const;

const FILTER_CLI_FLAGS = {
  sessionId: '--session-id',
  agentName: '--agent-name',
  model: '--model',
  provider: '--provider',
} as const;

function filterEntries(params: MetricsQueryParams): [keyof typeof FILTER_QUERY_KEYS, string][] {
  const filter = params.filter;
  if (filter === undefined) return [];
  return (Object.keys(FILTER_QUERY_KEYS) as (keyof typeof FILTER_QUERY_KEYS)[]).flatMap((key) => {
    const value = filter[key];
    return value === undefined || value === '' ? [] : [[key, value] as [keyof typeof FILTER_QUERY_KEYS, string]];
  });
}

function searchParams(params: MetricsQueryParams): string {
  const search = new URLSearchParams({
    groupBy: params.groupBy,
    period: params.period,
    sort: TOKEN_SORT,
    limit: String(params.limit),
    toolLimit: String(params.toolLimit ?? DEFAULT_TOOL_LIMIT),
  });
  for (const [key, value] of filterEntries(params)) search.set(FILTER_QUERY_KEYS[key], value);
  return search.toString();
}

async function queryHttp(
  endpoint: string,
  params: MetricsQueryParams,
  fetchImpl: typeof fetch,
): Promise<LogMetricsReport> {
  const response = await fetchImpl(`${endpoint}/api/metrics?${searchParams(params)}`, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`sink responded ${response.status}`);

  const body = (await response.json()) as LogMetricsReport & { error?: string };
  // An older daemon rejects unknown group-by values and omits the timeline.
  if (body.error || !Array.isArray(body.timeline)) throw new Error(body.error ?? 'sink is an older version');
  return body;
}

/**
 * The subprocess resolves an instance of its own from the inherited cwd and
 * environment, so the database is passed explicitly rather than left to agree
 * with this process by coincidence.
 */
function runCli(params: MetricsQueryParams, dbPath: string | undefined): Promise<LogMetricsReport> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        cliEntryPoint(),
        'logs',
        'metrics',
        '--group-by',
        params.groupBy,
        '--period',
        params.period,
        '--sort',
        TOKEN_SORT,
        '--limit',
        String(params.limit),
        '--tool-limit',
        String(params.toolLimit ?? DEFAULT_TOOL_LIMIT),
        ...filterEntries(params).flatMap(([key, value]) => [FILTER_CLI_FLAGS[key], value]),
        ...(dbPath === undefined ? [] : ['--db-path', dbPath]),
      ],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_CLI_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as LogMetricsReport);
        } catch {
          reject(new Error('metrics CLI returned unparsable output'));
        }
      },
    );
  });
}

/**
 * A malformed `.logsink.yaml` must not take the overlay down with it. Both
 * transports still run when resolution fails; they fall back to log-sink's own
 * resolution and the panel reports an unknown instance.
 */
function resolveInstance(identity: ResolveIdentity): MetricsInstance | undefined {
  try {
    const resolved = resolveLogSinkInstance(identity);
    return {
      scope: resolved.scope,
      dbPath: resolved.dbPath,
      ...(resolved.registeredName === undefined ? {} : { registeredName: resolved.registeredName }),
    };
  } catch {
    return undefined;
  }
}

export function createMetricsSource(options: MetricsSourceOptions = {}): MetricsSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const identity = {
    env: options.env,
    cwd: options.cwd,
    packageName: options.packageName,
    serviceName: options.serviceName,
  };
  let transport: MetricsTransport | undefined;
  let endpoint: string | undefined | null;
  const instance = resolveInstance(identity);
  const cliRunner = options.cliRunner ?? ((params: MetricsQueryParams) => runCli(params, instance?.dbPath));

  const resolveEndpoint = async (): Promise<string | undefined> => {
    if (endpoint !== undefined) return endpoint ?? undefined;
    try {
      const resolved = await resolveLogSinkPort({ ...identity, healthCheck: true });
      endpoint = resolved?.endpoint ?? null;
    } catch {
      endpoint = null;
    }
    return endpoint ?? undefined;
  };

  return {
    lastTransport: () => transport,
    instance: () => instance,
    async query(params) {
      const httpEndpoint = await resolveEndpoint();
      if (httpEndpoint && fetchImpl) {
        try {
          const report = await queryHttp(httpEndpoint, params, fetchImpl);
          transport = 'http';
          return report;
        } catch {
          // A stale or unhealthy daemon must not hide data the CLI can still read.
          endpoint = null;
        }
      }

      const report = await cliRunner(params);
      transport = 'cli';
      return report;
    },
  };
}
