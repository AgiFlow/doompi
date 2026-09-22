import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertSupportedDesktopTarget } from './desktopTarget.mjs';

assertSupportedDesktopTarget();

if (process.platform === 'darwin') {
  const packageDirectory = fileURLToPath(new URL('../native/macos-computer-use/', import.meta.url));
  const outputDirectory = fileURLToPath(new URL('../build/native/', import.meta.url));
  const swiftArguments = ['-c', 'release', '--arch', 'arm64', '--package-path', packageDirectory];
  const result = spawnSync('swift', ['build', ...swiftArguments], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('Failed to build the macOS computer-use helper.');
  const binaryDirectory = spawnSync('swift', ['build', '--show-bin-path', ...swiftArguments], { encoding: 'utf8' });
  if (binaryDirectory.status !== 0)
    throw new Error(`Failed to resolve the macOS computer-use helper output path.\n${binaryDirectory.stderr}`);
  const source = path.join(binaryDirectory.stdout.trim(), 'doompi-computer-use-helper');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp(source, path.join(outputDirectory, 'doompi-computer-use-helper'));
}
