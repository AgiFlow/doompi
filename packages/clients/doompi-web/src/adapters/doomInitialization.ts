import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';

const DOOMPI_PACKAGE = '@agimon-ai/doompi';
const CLI_SEGMENTS = ['dist', 'bin', 'cli.mjs'];

export interface DoomInitializationOptions {
  homeDirectory?: string;
  onNotice?: (message: string) => void;
  /** Test seam over the global configuration directory check. */
  exists?: (directory: string) => boolean;
  /** Test seam over the child command. */
  runInit?: () => Promise<void>;
}

function bundledDoomPiCli(): string {
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve(`${DOOMPI_PACKAGE}/package.json`));
  return path.join(packageRoot, ...CLI_SEGMENTS);
}

function runBundledInit(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundledDoomPiCli(), 'init'], {
      cwd: os.homedir(),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', (error) =>
      reject(new Error(`doompi init could not start: ${error.message}`, { cause: error })),
    );
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`doompi init exited with code ${String(code)}`));
    });
  });
}

/** Ensures the global configuration and managed Pi integration exist before the web hub starts. */
export async function ensureDoomInitialized(options: DoomInitializationOptions = {}): Promise<boolean> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const configDirectory = globalDoomConfigDirectory(homeDirectory);
  if ((options.exists ?? fs.existsSync)(configDirectory)) return false;
  options.onNotice?.(`${configDirectory} is missing; running doompi init`);
  await (options.runInit ?? runBundledInit)();
  return true;
}
