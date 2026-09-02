/**
 * Signs the Mach-O binaries inside the desktop runtime artifact.
 *
 * electron-builder signs the app bundle and unpacked files, but the staged
 * native addons and executables still need explicit hardened-runtime signing
 * before the enclosing bundle is signed. Signing happens deepest-first because
 * signing an inner file afterwards would invalidate the outer signature.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    if (fs.readSync(handle, header, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(header.readUInt32BE(0)) || MACH_O_MAGIC.has(header.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function collect(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(entryPath, found);
      continue;
    }
    if (entry.isFile() && isMachO(entryPath)) found.push(entryPath);
  }
  return found;
}

const depth = (filePath) => filePath.split(path.sep).length;

exports.default = async function signHubBinaries(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const identity = process.env.CSC_NAME ?? process.env.APPLE_SIGNING_IDENTITY;
  if (identity === undefined || identity === '') {
    console.log('[sign-hub] no signing identity, leaving the payload unsigned');
    return;
  }

  const runtimeDirectory = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'runtime',
  );
  if (!fs.existsSync(runtimeDirectory)) {
    throw new Error(`The desktop runtime is missing at ${runtimeDirectory}`);
  }

  const entitlements = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');
  const binaries = collect(runtimeDirectory).sort((left, right) => depth(right) - depth(left));
  if (binaries.length === 0) throw new Error(`The desktop runtime has no Mach-O binaries at ${runtimeDirectory}`);

  for (const binary of binaries) {
    const result = spawnSync(
      'codesign',
      ['--sign', identity, '--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, binary],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`codesign failed for ${binary}`);
  }

  console.log(`[sign-hub] signed ${String(binaries.length)} binaries in the desktop runtime`);
};
