import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSupportedDesktopTarget } from './desktopTarget.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetName = assertSupportedDesktopTarget();
const arch = targetName.slice(targetName.lastIndexOf('-') + 1);
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
const commit = source.stdout?.trim();
if (source.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit ?? ''))
  throw new Error('Cannot determine desktop source commit.');
// Signed plist fields retain full SemVer and source identity across the build/upload boundary.
const builderArgs = [
  '--config',
  'electron-builder.yml',
  '--publish',
  'never',
  `--${arch}`,
  `--config.mac.extendInfo.DoomPiVersion=${version}`,
  `--config.mac.extendInfo.DoomPiCommit=${commit}`,
];
const outputDirectory = process.env.DOOMPI_DESKTOP_OUTPUT_DIR?.trim();
const requireSigning =
  process.env.DOOMPI_DESKTOP_REQUIRE_SIGNING === '1' || process.env.DOOMPI_DESKTOP_REQUIRE_SIGNING === 'true';
if (outputDirectory !== undefined && outputDirectory !== '') {
  if (!path.isAbsolute(outputDirectory)) throw new Error('DOOMPI_DESKTOP_OUTPUT_DIR must be an absolute path.');
  builderArgs.push(`--config.directories.output=${outputDirectory}`);
}
if (requireSigning) {
  if ((process.env.CSC_NAME ?? '').trim() === '') throw new Error('CSC_NAME is required for a signed desktop package.');
  builderArgs.push('--config.forceCodeSigning=true');
}
const result = spawnSync('npx', ['--yes', 'electron-builder@26.0.12', ...builderArgs], {
  cwd: packageRoot,
  stdio: 'inherit',
});
if (result.error || result.status !== 0) throw new Error(`electron-builder failed for ${targetName}.`);
