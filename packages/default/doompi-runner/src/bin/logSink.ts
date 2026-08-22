import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { scrubTerminalOutput } from '../services/AnsiScrub/ansiScrub';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const telemetry = createDoomTelemetry({
    serviceName: 'doom-runner-log-sink',
    packageName: '@agimon-ai/doompi-runner',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const [logPath, rotatedPath, maxBytesRaw, donePath] = argv;
  try {
    // Keep the legacy argument shape for the published executable subpath. Raw
    // logs are append-only now, so the former rotation path and ceiling are not used.
    if (!logPath || !rotatedPath || !maxBytesRaw || !donePath) {
      throw new Error('logSink requires log, rotated log, max bytes, and completion paths');
    }
  } catch (error) {
    await telemetry.recordError('doom_runner.file_sink_failed', error, { duration_ms: Date.now() - startedAt });
    await telemetry.shutdown();
    throw error;
  }

  let handle: number;
  let written: number;
  try {
    handle = fs.openSync(logPath, 'a');
    written = fs.statSync(logPath).size;
  } catch (error) {
    await telemetry.recordError('doom_runner.file_sink_failed', error, { duration_ms: Date.now() - startedAt });
    await telemetry.shutdown();
    throw error;
  }
  let chunks = 0;
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      const text = scrubTerminalOutput(String(chunk));
      if (!text) continue;
      const bytes = Buffer.from(text, 'utf8');
      fs.writeSync(handle, bytes);
      written += bytes.byteLength;
      chunks += 1;
    }
    fs.closeSync(handle);
    writeDone(donePath);
    await telemetry.recordEvent('doom_runner.file_sink_finished', {
      outcome: 'completed',
      'runner.chunk_count': chunks,
      'runner.bytes_written': written,
      duration_ms: Date.now() - startedAt,
    });
    return 0;
  } catch (error) {
    await telemetry.recordError('doom_runner.file_sink_failed', error, { duration_ms: Date.now() - startedAt });
    throw error;
  } finally {
    await telemetry.shutdown();
  }
}

function writeDone(target: string): void {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, '', { mode: 0o600 });
  fs.renameSync(temporary, target);
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
