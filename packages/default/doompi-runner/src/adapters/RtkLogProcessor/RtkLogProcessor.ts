import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getResultMaxBytes } from '../../types/config.ts';
import type { IRtkLogProcessor } from '../../types/rtkLogProcessor';

const EXECUTABLE_MODE = 0o755;
const RTK_TIMEOUT_MS = 30_000;
const RTK_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PACKAGE_BY_PLATFORM: Readonly<Record<string, string>> = {
  'darwin-arm64': '@agimon-ai/doompi-runner-rtk-darwin-arm64',
  'darwin-x64': '@agimon-ai/doompi-runner-rtk-darwin-x64',
  'linux-arm64': '@agimon-ai/doompi-runner-rtk-linux-arm64',
  'linux-x64': '@agimon-ai/doompi-runner-rtk-linux-x64',
};

type BinaryCandidates = () => readonly string[];

export class RtkLogProcessor implements IRtkLogProcessor {
  constructor(
    private readonly binaryCandidates: BinaryCandidates = rtkBinaryCandidates,
    private readonly rawFallbackMaxBytes = getResultMaxBytes(),
  ) {}

  async process(logPath: string): Promise<string> {
    let failure: unknown = new Error('no RTK executable was resolved');
    for (const binary of this.binaryCandidates()) {
      try {
        if (binary !== 'rtk') fs.chmodSync(binary, EXECUTABLE_MODE);
        return await runRtk(binary, logPath);
      } catch (error) {
        failure = error;
      }
    }

    const warning = `RTK log processing failed (${errorMessage(failure)}). Showing bounded raw log output.`;
    process.emitWarning(warning);
    const raw = readTail(logPath, this.rawFallbackMaxBytes).replace(/\r?\n$/u, '');
    return raw.length > 0 ? `${raw}\n[warning: ${warning}]\n` : `[warning: ${warning}]\n`;
  }
}

export function rtkPackageForTarget(platform: string, architecture: string): string | undefined {
  const target = `${platform}-${architecture}`;
  const packageName = PACKAGE_BY_PLATFORM[target];
  if (!packageName) process.emitWarning(`Bundled RTK binary is unavailable for unsupported target ${target}`);
  return packageName;
}

function rtkBinaryCandidates(): readonly string[] {
  const bundled = bundledBinary();
  return bundled ? [bundled, 'rtk'] : ['rtk'];
}

function bundledBinary(): string | undefined {
  const packageName = rtkPackageForTarget(process.platform, process.arch);
  if (!packageName) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${packageName}/package.json`);
    return path.join(path.dirname(manifest), 'vendor', 'bin', 'rtk');
  } catch (error) {
    process.emitWarning(`Bundled RTK binary is unavailable for ${packageName}: ${errorMessage(error)}`);
    return undefined;
  }
}

function runRtk(binary: string, logPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['log', logPath],
      { encoding: 'utf8', maxBuffer: RTK_MAX_OUTPUT_BYTES, timeout: RTK_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function readTail(target: string, maxBytes: number): string {
  let handle: number | undefined;
  try {
    const size = fs.statSync(target).size;
    const length = Math.min(size, Math.max(0, maxBytes));
    if (length === 0) return '';
    const buffer = Buffer.allocUnsafe(length);
    handle = fs.openSync(target, 'r');
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.emitWarning(`Could not read raw runner log ${target}: ${errorMessage(error)}`);
    }
    return '';
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
