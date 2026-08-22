#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { runCli } from '../commands/cli/cliApp.ts';
import { createRunnerContainer } from '../container/index.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const telemetry = createDoomTelemetry({
    serviceName: 'doom-runner-cli',
    packageName: '@agimon-ai/doompi-runner',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const container = createRunnerContainer();
  const registry = container.runnerRegistry;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  try {
    const exitCode = await runCli(argv, {
      registry,
      launcher: container.launcher,
      rmuxBackend: container.rmuxBackend,
      logReader: container.logReader,
      env: process.env,
      stdout: (text) => {
        const output = text.endsWith('\n') ? text : `${text}\n`;
        stdoutBytes += Buffer.byteLength(output, 'utf8');
        process.stdout.write(output);
      },
      stderr: (text) => {
        const output = text.endsWith('\n') ? text : `${text}\n`;
        stderrBytes += Buffer.byteLength(output, 'utf8');
        process.stderr.write(output);
      },
      readStdin,
    });
    await telemetry.recordEvent('doom_runner.cli_finished', {
      outcome: exitCode === 0 ? 'completed' : 'failed',
      'runner.exit_code': exitCode,
      duration_ms: Date.now() - startedAt,
      'runner.argument_count': argv.length,
      'runner.stdout_bytes': stdoutBytes,
      'runner.stderr_bytes': stderrBytes,
    });
    return exitCode;
  } catch (error) {
    await telemetry.recordError('doom_runner.cli_failed', error, {
      duration_ms: Date.now() - startedAt,
      'runner.argument_count': argv.length,
      'runner.stdout_bytes': stdoutBytes,
      'runner.stderr_bytes': stderrBytes,
    });
    throw error;
  } finally {
    registry.close();
    await telemetry.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
