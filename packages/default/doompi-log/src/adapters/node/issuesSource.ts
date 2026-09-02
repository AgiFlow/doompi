import { execFile } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveLogSinkInstance } from '@agimon-ai/log-sink-mcp';
import type { AgentIssueSample, IssuesQueryParams, IssuesReport, IssuesSource } from '../../types/issuesSource.ts';

/**
 * Agent-issue analysis over the sink's CLI.
 *
 * One transport, not two, because the daemon serves only /api/metrics and
 * /api/logs: there is no issues route to prefer. Every call is a subprocess,
 * which is why the page asks for this only when a reader opens the section
 * rather than alongside each report.
 */

const PACKAGE_NAME = '@agimon-ai/log-sink-mcp';
const CLI_TIMEOUT_MS = 60000;
/** The analysis scans the whole window, so its output is larger than a metrics report. */
const MAX_CLI_BUFFER = 32 * 1024 * 1024;

export interface IssuesSourceOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  packageName?: string;
  serviceName?: string;
  /** Overrides the subprocess in tests. */
  cliRunner?: (params: IssuesQueryParams) => Promise<unknown>;
}

function cliEntryPoint(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(`${PACKAGE_NAME}/package.json`);
  return path.join(path.dirname(packageJson), 'dist', 'cli.mjs');
}

function runCli(params: IssuesQueryParams, dbPath: string | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        cliEntryPoint(),
        'logs',
        'agent-issues',
        '--limit',
        String(params.limit),
        ...(params.sessionId === undefined ? [] : ['--session-id', params.sessionId]),
        ...(dbPath === undefined ? [] : ['--db-path', dbPath]),
      ],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_CLI_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new Error('The log sink returned output this version cannot read.'));
        }
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function counts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).flatMap(([key, count]) =>
    typeof count === 'number' ? [[key, count] as [string, number]] : [],
  );
  return Object.fromEntries(entries);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toSample(value: unknown): AgentIssueSample[] {
  if (!isRecord(value)) return [];
  return [
    {
      fingerprint: text(value.fingerprint),
      occurrenceCount: typeof value.occurrenceCount === 'number' ? value.occurrenceCount : 1,
      category: text(value.category),
      timestamp: text(value.timestamp),
      level: text(value.level),
      message: text(value.message),
      // The sink leaves detail null when the message already is the detail.
      detail: nullableText(value.detail) ?? text(value.message),
      tool: nullableText(value.tool),
      errorType: nullableText(value.errorType),
      agentName: nullableText(value.agentName),
      model: nullableText(value.model),
      statusCode: nullableText(value.statusCode),
    },
  ];
}

/**
 * The CLI's report is a foreign process's JSON, so every field is narrowed
 * here rather than cast. A sink one version ahead may add fields, and a sink
 * one version behind may omit them; neither should throw.
 */
function toReport(raw: unknown): IssuesReport {
  if (!isRecord(raw)) throw new Error('The log sink returned output this version cannot read.');
  const samples = Array.isArray(raw.issues) ? raw.issues.flatMap(toSample) : [];
  return {
    totalIssues: typeof raw.totalIssues === 'number' ? raw.totalIssues : 0,
    uniqueIncidents: typeof raw.uniqueIncidents === 'number' ? raw.uniqueIncidents : 0,
    byCategory: counts(raw.byCategory),
    byTool: counts(raw.byTool),
    byErrorType: counts(raw.byErrorType),
    samples,
  };
}

export function createIssuesSource(options: IssuesSourceOptions = {}): IssuesSource {
  const instance = resolveLogSinkInstance({
    env: options.env,
    cwd: options.cwd,
    packageName: options.packageName,
    serviceName: options.serviceName,
  });
  const cliRunner = options.cliRunner ?? ((params: IssuesQueryParams) => runCli(params, instance?.dbPath));

  return {
    async query(params) {
      return toReport(await cliRunner(params));
    },
  };
}
