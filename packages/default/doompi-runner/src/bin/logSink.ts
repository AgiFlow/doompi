import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scrubTerminalOutput } from '../services/ansiScrub';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const telemetry = createDoomTelemetry({
    serviceName: 'doom-runner-log-sink',
    packageName: '@agimon-ai/doompi-runner',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const [logPath, rotatedPath, maxBytesRaw, donePath, rawPath] = argv;
  try {
    // Keep the legacy argument shape for the published executable subpath. The
    // scrubbed log is append-only, so the former rotation path is unused; the
    // ceiling now bounds the raw copy, which only interactive runs ask for.
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
  // The pane's bytes before anything is taken out of them. Scrubbing exists so
  // the log stays worth grepping, and it is exactly what makes the log useless
  // to a terminal, so an attached view needs its own faithful copy.
  const rawCeiling = Number.parseInt(maxBytesRaw, 10);
  const raw = rawPath === undefined || rawPath === '' ? undefined : openRaw(rawPath);
  let rawWritten = raw === undefined ? 0 : rawSize(rawPath as string);
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      const source = String(chunk);
      if (raw !== undefined) {
        const rawBytes = Buffer.from(source, 'utf8');
        // A terminal that scrolls all day must not fill the disk. Past the
        // ceiling the copy starts over: a reader attaching later wants the
        // recent screen, and no part of this is the record of the run.
        if (rawWritten + rawBytes.byteLength > rawCeiling) {
          fs.ftruncateSync(raw, 0);
          rawWritten = 0;
        }
        fs.writeSync(raw, rawBytes);
        rawWritten += rawBytes.byteLength;
      }
      const text = scrubTerminalOutput(source);
      if (!text) continue;
      const bytes = Buffer.from(text, 'utf8');
      fs.writeSync(handle, bytes);
      written += bytes.byteLength;
      chunks += 1;
    }
    fs.closeSync(handle);
    if (raw !== undefined) fs.closeSync(raw);
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

/** Truncating rather than appending: a stale pane from a previous run is not this one's. */
function openRaw(target: string): number {
  return fs.openSync(target, 'w');
}

function rawSize(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
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
