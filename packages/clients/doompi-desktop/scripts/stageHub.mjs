#!/usr/bin/env node
/**
 * Stages the cockpit and everything it runs into `build/hub`.
 *
 * `pnpm deploy` is what makes this work: the workspace store is a forest of
 * symlinks that electron-builder copies incorrectly, and deploy resolves it
 * into one real directory tree. The result is shipped as `extraResources`
 * rather than packed into the asar, because the cockpit can exec real binaries
 * and an archive member cannot be executed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(packageRoot, 'build', 'hub');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });

const result = spawnSync('pnpm', ['deploy', '--filter', '@agimon-ai/doompi-web', '--prod', '--legacy', target], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.stderr.write(
    '[stage-hub] pnpm deploy failed. On pnpm 10+ this usually means the workspace needs ' +
      'inject-workspace-packages=true, or the --legacy flag is no longer accepted.\n',
  );
  process.exit(result.status ?? 1);
}

// pnpm deploy writes the package at the root of the target, with its
// dependencies in node_modules beside it.
const entry = path.join(target, 'dist', 'bin', 'serve.mjs');
if (!fs.existsSync(entry)) {
  process.stderr.write(`[stage-hub] deploy completed but the cockpit entry is missing at ${entry}\n`);
  process.exit(1);
}

/**
 * Replaces symlinks that point outside the payload with real copies.
 *
 * `pnpm deploy` leaves a few links in its hoist directory pointing back at the
 * workspace checkout. They resolve on this machine and nowhere else, and
 * electron-builder refuses them outright because a link escaping the archive
 * violates asar integrity. Dereferencing is the honest fix: the payload is
 * supposed to be self-contained, and a link to a directory that will not exist
 * on the user's machine is a bug whether or not the packager catches it.
 */
function dereferenceEscapingLinks(directory, root, replaced = { count: 0 }) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isSymbolicLink()) {
      let resolved;
      try {
        resolved = fs.realpathSync(itemPath);
      } catch {
        // A link that resolves nowhere cannot be copied either.
        fs.rmSync(itemPath, { force: true });
        replaced.count += 1;
        continue;
      }
      if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) continue;
      fs.rmSync(itemPath, { recursive: true, force: true });
      fs.cpSync(resolved, itemPath, { recursive: true, dereference: true });
      replaced.count += 1;
      continue;
    }
    if (item.isDirectory()) dereferenceEscapingLinks(itemPath, root, replaced);
  }
  return replaced.count;
}

const payloadRoot = fs.realpathSync(target);
const replaced = dereferenceEscapingLinks(payloadRoot, payloadRoot);
if (replaced > 0) process.stdout.write(`[stage-hub] inlined ${String(replaced)} link(s) that escaped the payload\n`);

process.stdout.write(`[stage-hub] staged the cockpit at ${target}\n`);
