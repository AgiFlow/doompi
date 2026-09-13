#!/usr/bin/env node
import { packagedVersion } from '../adapters/packageVersion.ts';
import { parseServeOptions, serveHelp } from '../services/serveOptions.ts';

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

  const { serveWeb } = await import('../adapters/httpServer.ts');
  const server = await serveWeb({
    port: options.port,
    host: options.host,
    assetsDir: options.assetsDir,
    headlessUrl: options.headlessUrl,
    headlessToken: options.headlessToken,
    onNotice: notice,
  });
  notice(`serving browser assets at ${server.url}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().then(
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
