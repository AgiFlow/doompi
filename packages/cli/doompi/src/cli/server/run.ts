import { runServerRuntime } from '../../builders/server/runtime';
import { runSync } from '../commands/sync/workflow';
import { resolveHarnessOptions } from '../harnessOptions';
import { parseServeOptions } from './options';

export async function runServer(args: readonly string[]): Promise<number> {
  const options = parseServeOptions(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await runServerRuntime(options, {
      cwd: process.cwd(),
      environment: Object.freeze({ ...process.env }),
      signal: controller.signal,
      resolveHarnessOptions,
      notice: (message) => void process.stderr.write(`[doompi-server] ${message}\n`),
      syncWorkspace: async (root, environment) => {
        let output = '';
        const code = await runSync(['sync'], environment, root, {
          write(chunk) {
            output += String(chunk);
            return true;
          },
        });
        if (code !== 0) throw new Error(output.trim() || `Workspace sync exited with code ${code}`);
      },
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
