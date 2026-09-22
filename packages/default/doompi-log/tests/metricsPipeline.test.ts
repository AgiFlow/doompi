import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext, DoomHeadlessEventName } from '@agimon-ai/doompi-core/headless';
import { createAsyncLogMetricsReader } from '@agimon-ai/log-sink-mcp';
import { expect, it } from 'vitest';

import { createLogHubApi } from '../src/services/hubApi';
import { createMetricsSource } from '../src/services/metricsSource';
import { createServerTelemetry } from '../src/services/serverTelemetry';
import type { MetricsReport } from '../src/types/webMetrics';

it('exports headless and MCP tool records through a real sink and reads them through the settings API', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-metrics-pipeline-'));
  const dbPath = path.join(directory, 'session.db');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') throw new Error('No test TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${port}`;
  const require = createRequire(import.meta.url);
  const sinkRoot = path.dirname(require.resolve('@agimon-ai/log-sink-mcp/package.json'));
  const sink = spawn(
    process.execPath,
    [
      path.join(sinkRoot, 'dist/cli.mjs'),
      'http-serve',
      '--port',
      String(port),
      '--db-path',
      dbPath,
      '--registry-path',
      path.join(directory, 'registry'),
    ],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let diagnostics = '';
  sink.stdout.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
  });
  sink.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
  });
  const exit = once(sink, 'exit');
  const reader = createAsyncLogMetricsReader({ dbPath });
  const source = createMetricsSource({
    cwd: directory,
    env: {},
    packageName: '@agimon-ai/doompi-log',
    serviceName: 'pi',
    workerReader: reader,
    // Never consult another repository's daemon. This tests the offline worker path.
    fetchImpl: async () => {
      throw new Error('Use isolated history');
    },
  });
  const runtime = createServerTelemetry();
  const execution = {
    cwd: directory,
    sessionId: 'pipeline-session',
    environment: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, AGENT_OTEL_TRACES: 'false' },
    model: { provider: 'pipeline-provider', id: 'pipeline-model' },
    client: { setStatus() {}, async notify() {} },
  } as unknown as DoomHeadlessExecutionContext;
  let dispose: (() => void | Promise<void>) | undefined;
  const emit = async (event: DoomHeadlessEventName, payload: Record<string, unknown> = {}) => {
    const hook = runtime.hooks.find((candidate) => candidate.event === event);
    if (!hook) throw new Error(`Missing telemetry hook ${event}`);
    await hook.handle(payload as never, execution);
  };
  try {
    await expect
      .poll(
        async () => {
          if (sink.exitCode !== null) throw new Error(`Sink exited: ${diagnostics}`);
          try {
            return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })).ok;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    dispose = await runtime.activities[0]!.start(execution);
    await emit('session_start');
    await emit('turn_start', { turnId: 'turn-a' });
    await emit('turn_end', {
      turnId: 'turn-a',
      message: {
        role: 'assistant',
        model: 'pipeline-model',
        provider: 'pipeline-provider',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'private response must not be exported' }],
        usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135, cost: { total: 0.02 } },
      },
      toolResults: [{ toolName: 'read' }],
    });
    await emit('tool_execution_start', {
      toolCallId: 'external-pipeline',
      toolName: 'external-read',
      args: { path: 'private-path' },
    });
    await emit('tool_execution_end', { toolCallId: 'external-pipeline', toolName: 'external-read', isError: false });
    await emit('agent_settled');
    const app = createLogHubApi({ source });
    await expect
      .poll(
        async () => {
          const response = await app.request('/metrics?dimension=model&period=week');
          const body = (await response.json()) as MetricsReport;
          return { tokens: body.totals?.totalTokens, tools: body.tools?.map((tool) => [tool.name, tool.calls]) };
        },
        { timeout: 10_000 },
      )
      .toEqual({ tokens: 135, tools: [['read', 1]] });
    const response = await app.request('/metrics?dimension=model&period=week');
    const report = (await response.json()) as MetricsReport;
    expect(report.totals).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 135 });
    expect(report.tools.some((tool) => tool.name === 'read')).toBe(true);
    expect(source.lastTransport()).toBe('worker');
    expect(JSON.stringify(report)).not.toContain('private');
    const http = await fetch(`${endpoint}/api/metrics?groupBy=model&period=week`);
    expect(http.ok).toBe(true);
    expect(((await http.json()) as { totals: { totalTokens: number } }).totals.totalTokens).toBe(135);
    // Query the real stdio MCP server too. External calls are retained as
    // call/result records, not invented token-attribution samples.
    const logs = execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'helpers/queryLogSinkMcp.cjs'),
        path.join(sinkRoot, 'package.json'),
        dbPath,
        directory,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(logs).toContain('pi.tool_call');
    expect(logs).toContain('pi.tool_result');
    expect(logs).toContain('external-read');
    expect(logs).not.toContain('private');
    await emit('session_shutdown');
  } finally {
    await dispose?.();
    await source.close?.();
    sink.kill('SIGTERM');
    const timer = setTimeout(() => sink.kill('SIGKILL'), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
