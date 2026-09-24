import { execFile } from 'node:child_process';
import os from 'node:os';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';

import { runServerRuntime } from '../../builders/server/runtime';
import { readSyncDrift } from '../../composition/syncDrift';
import { resolveHarnessOptions } from '../harnessOptions';
import { parseServeOptions } from './options';

const DOOMPI_ROOT_ENV = 'DOOMPI_ROOT';
const SYNC_CHILD_SCRIPT = `
const [workflowUrl, root, globalFlag] = process.argv.slice(1);
try {
  const { runSync } = await import(workflowUrl);
  let output = '';
  const code = await runSync(globalFlag === '1' ? ['sync', '--global'] : ['sync'], process.env, root, {
    write(chunk) {
      output += String(chunk);
      return true;
    },
  });
  if (code !== 0) {
    process.stderr.write(output.trim() || \`Workspace sync exited with code \${String(code)}\`);
    process.exitCode = code;
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function syncWorkflowUrl(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
  return new URL(`../commands/sync/workflow.${extension}`, import.meta.url).href;
}

function runSyncProcess(root: string, syncEnvironment: NodeJS.ProcessEnv, global: boolean): Promise<void> {
  const environment = global ? { ...syncEnvironment, [DOOMPI_ROOT_ENV]: root } : syncEnvironment;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        ...process.execArgv,
        '--input-type=module',
        '--eval',
        SYNC_CHILD_SCRIPT,
        syncWorkflowUrl(),
        root,
        global ? '1' : '0',
      ],
      { cwd: root, env: environment, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = `${stderr || stdout}`.trim();
        reject(new Error(detail || `Workspace sync exited with code ${String(error.code ?? 1)}`));
      },
    );
  });
}
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
    await runSyncProcess(root, syncEnvironment, global);
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
