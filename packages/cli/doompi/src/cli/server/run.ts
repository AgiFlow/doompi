import os from 'node:os';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';

import { runServerRuntime } from '../../builders/server/runtime';
import { readSyncDrift } from '../../composition/syncDrift';
import { runSync } from '../commands/sync/workflow';
import { resolveHarnessOptions } from '../harnessOptions';
import { parseServeOptions } from './options';

const DOOMPI_ROOT_ENV = 'DOOMPI_ROOT';

export async function runServer(args: readonly string[]): Promise<number> {
  const options = parseServeOptions(args);
  const environment = Object.freeze({ ...process.env });
  const syncRuntime = async (root: string, syncEnvironment: NodeJS.ProcessEnv, global = false): Promise<void> => {
    const runtimeDrift = readSyncDrift({
      repoRoot: root,
      homeDirectory: syncEnvironment.HOME,
      requireFreshSources: false,
      requireWebBundle: true,
    });
    if (runtimeDrift.fresh) return;
    let output = '';
    const environment = global ? { ...syncEnvironment, [DOOMPI_ROOT_ENV]: root } : syncEnvironment;
    const code = await runSync(global ? ['sync', '--global'] : ['sync'], environment, root, {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    });
    if (code !== 0) throw new Error(output.trim() || `Workspace sync exited with code ${String(code)}`);
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // An IPC parent owns this server's lifetime. Its channel closes even when the
  // parent is killed before it can forward a termination signal.
  process.on('disconnect', stop);
  try {
    await syncRuntime(globalDoomConfigDirectory(environment.HOME ?? os.homedir()), environment, true);
    return await runServerRuntime(options, {
      cwd: process.cwd(),
      environment,
      signal: controller.signal,
      resolveHarnessOptions,
      notice: (message) => void process.stderr.write(`[doompi-server] ${message}\n`),
      syncWorkspace: syncRuntime,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('disconnect', stop);
  }
}
