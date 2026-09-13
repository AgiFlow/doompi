import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSupportedDesktopTarget } from './desktopTarget.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetName = assertSupportedDesktopTarget();
const arch = targetName.slice(targetName.lastIndexOf('-') + 1);
const result = spawnSync(
  'npx',
  ['--yes', 'electron-builder@26.0.12', '--config', 'electron-builder.yml', '--publish', 'never', `--${arch}`],
  { cwd: packageRoot, stdio: 'inherit' },
);
if (result.status !== 0) throw new Error(`electron-builder failed for ${targetName}.`);
