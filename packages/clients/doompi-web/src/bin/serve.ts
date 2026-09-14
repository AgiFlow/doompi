#!/usr/bin/env node
import type { HeadlessProcess } from '../adapters/headlessProcess';
import { packagedVersion } from '../adapters/packageVersion';
import { DEFAULT_HEADLESS_URL, ownsHeadlessProcess } from '../services/headlessLaunch';
import { parseServeOptions, serveHelp } from '../services/serveOptions';

function notice(message: string): void {
  process.stderr.write(`[doompi-web] ${message}\n`);
}

async function main(): Promise<void> {
  const options = parseServeOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(serveHelp());
    return;
  }
  if (options.version) {
    process.stdout.write(`${packagedVersion()}\n`);
    return;
  }

  const headlessUrl = options.headlessUrl ?? DEFAULT_HEADLESS_URL;
  let headless: HeadlessProcess | undefined;
  if (ownsHeadlessProcess(options)) {
    const { startHeadless } = await import('../adapters/headlessProcess');
    headless = await startHeadless({ url: headlessUrl, environment: process.env, onNotice: notice });
  }

  const { serveWeb } = await import('../adapters/httpServer');
  const server = await serveWeb({
    port: options.port,
    host: options.host,
    assetsDir: options.assetsDir,
    headlessUrl,
    headlessToken: options.headlessToken ?? headless?.token,
    onNotice: notice,
  });
  notice(`serving browser assets at ${server.url}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server
      .close()
      .then(async () => {
        await headless?.close();
      })
      .then(
        () => process.exit(0),
        (error: unknown) => {
          notice(error instanceof Error ? error.message : String(error));
          process.exit(1);
        },
      );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  notice(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
