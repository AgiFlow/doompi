import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const packageRoots = [
  'packages/core',
  'packages/default',
  'packages/minor',
  'packages/clients',
  'packages/tooling',
  'layers',
];
const packagePatterns = ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/package.json'];
const pathspecs = packageRoots.flatMap((packageRoot) => packagePatterns.map((pattern) => `${packageRoot}/${pattern}`));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map((file) => path.join(root, file));

if (files.length === 0) {
  console.log('[vibe-lint] No tracked package files matched.');
  process.exit(0);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-vibe-lint-'));
const fileList = path.join(temporaryRoot, 'files.txt');
fs.writeFileSync(fileList, `${files.join('\n')}\n`, 'utf8');

try {
  console.log(`[vibe-lint] Reviewing ${files.length} package files.`);
  const result = spawnSync('vibe-lint', ['check', '--files-from', fileList, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
