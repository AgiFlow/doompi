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
  const result = spawnSync('swift', ['build', '-c', 'release', '--arch', 'arm64', '--package-path', packageDirectory], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('Failed to build the macOS computer-use helper.');
  const source = path.join(packageDirectory, '.build', 'arm64-apple-macosx', 'release', 'doompi-computer-use-helper');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp(source, path.join(outputDirectory, 'doompi-computer-use-helper'));
}
