/**
 * Signs the Mach-O binaries inside the desktop runtime artifact.
 *
 * electron-builder signs the app bundle and unpacked files, but the staged
 * native addons and executables still need explicit hardened-runtime signing
 * before the enclosing bundle is signed. Signing happens deepest-first because
 * signing an inner file afterwards would invalidate the outer signature.
 */
const { execFileSync, spawnSync } = require('node:child_process');
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

// Apple also inspects the offline package archives used by first-run sync.
function signCatalogArchives(catalogDirectory, signBinary) {
  let signed = 0;
  for (const entry of fs.readdirSync(catalogDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tgz')) continue;
    const archive = path.join(catalogDirectory, entry.name);
    const temporary = fs.mkdtempSync(path.join(catalogDirectory, '.sign-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', temporary]);
      const binaries = collect(temporary).sort((left, right) => depth(right) - depth(left));
      if (binaries.length === 0) continue;
      for (const binary of binaries) signBinary(binary);
      const replacement = path.join(temporary, 'signed.tgz');
      execFileSync('tar', ['--no-xattrs', '-czf', replacement, '-C', temporary, 'package']);
      fs.renameSync(replacement, archive);
      signed += binaries.length;
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return signed;
}
exports.signCatalogArchives = signCatalogArchives;

exports.default = async function signHubBinaries(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const identity = process.env.CSC_NAME ?? process.env.APPLE_SIGNING_IDENTITY;
  if (identity === undefined || identity === '') {
    console.log('[sign-hub] no signing identity, leaving the payload unsigned');
    return;
  }

  const resourcesDirectory = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const runtimeDirectory = path.join(resourcesDirectory, 'runtime');
  const helperPath = path.join(resourcesDirectory, 'native', 'doompi-computer-use-helper');
  if (!fs.existsSync(runtimeDirectory)) throw new Error(`The desktop runtime is missing at ${runtimeDirectory}`);
  if (!fs.existsSync(helperPath) || !isMachO(helperPath))
    throw new Error(`The macOS computer-use helper is missing or invalid at ${helperPath}`);

  const runtimeEntitlements = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist');
  const helperEntitlements = path.join(__dirname, '..', 'resources', 'entitlements.helper.mac.plist');
  const binaries = [...collect(runtimeDirectory), helperPath].sort((left, right) => depth(right) - depth(left));
  if (binaries.length < 2) throw new Error(`The packaged app has no signable native payload at ${resourcesDirectory}`);

  const signBinary = (binary, entitlements) => {
    const result = spawnSync(
      'codesign',
      ['--sign', identity, '--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, binary],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`codesign failed for ${binary}`);
    const verification = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', binary], { stdio: 'inherit' });
    if (verification.status !== 0) throw new Error(`Developer ID signature validation failed for ${binary}`);
  };
  for (const binary of binaries) signBinary(binary, binary === helperPath ? helperEntitlements : runtimeEntitlements);
  const archived = signCatalogArchives(path.join(runtimeDirectory, 'catalog'), (binary) =>
    signBinary(binary, runtimeEntitlements),
  );

  console.log(`[sign-hub] signed ${String(binaries.length)} native files and ${String(archived)} archived binaries`);
};
