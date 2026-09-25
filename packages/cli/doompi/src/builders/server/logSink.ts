import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveLogSinkPort } from '@agimon-ai/log-sink-mcp';

const START_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 4_000;
const HEALTH_TIMEOUT_MS = 750;
const DISCOVERY_INTERVAL_MS = 1_100;

const execFileAsync = promisify(execFile);

async function healthy(env: NodeJS.ProcessEnv): Promise<boolean> {
  // Registry discovery may wait on a broken daemon's health endpoint. The
  // server must still start, without allowing that endpoint to select a local
  // fallback or hold the startup path indefinitely.
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      resolveLogSinkPort({ env, healthCheck: true }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), HEALTH_TIMEOUT_MS);
      }),
    ]);
    return result !== undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Attach to the shared daemon or start it through its published CLI. Never own its shutdown. */
export async function ensureGlobalLogSink(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  notice: (message: string) => void;
}): Promise<void> {
  const { cwd, env, notice } = options;
  let failure: string | undefined;
  try {
    if (await healthy(env)) return;
    const cli = fileURLToPath(import.meta.resolve('@agimon-ai/log-sink-mcp/cli'));
    await execFileAsync(process.execPath, [cli, 'start', '--global', '--http-only'], {
      cwd,
      env,
      timeout: START_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  do {
    if (await healthy(env)) return;
    if (Date.now() + DISCOVERY_INTERVAL_MS > deadline) break;
    await sleep(DISCOVERY_INTERVAL_MS);
  } while (Date.now() < deadline);

  notice(`Global log sink unavailable: ${failure ?? 'healthy discovery timed out'}. Telemetry remains nonfatal.`);
}
