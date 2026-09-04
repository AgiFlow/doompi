import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.8.3';
const TARGETS = {
  'darwin-arm64': {
    archive: true,
    asset: 'cloudflared-darwin-arm64.tgz',
    sha256: '40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f',
  },
  'linux-x64': {
    archive: false,
    asset: 'cloudflared-linux-amd64',
    sha256: 'f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e',
  },
};
const LICENSE_SHA256 = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd';

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function download(url, expectedDigest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${String(response.status)}`);
  const contents = Buffer.from(await response.arrayBuffer());
  const actualDigest = digest(contents);
  if (actualDigest !== expectedDigest) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expectedDigest}, received ${actualDigest}`);
  }
  return contents;
}

const targetName = `${process.platform}-${process.arch}`;
const target = TARGETS[targetName];
if (target === undefined) throw new Error(`DoomPi Desktop does not package cloudflared for ${targetName}.`);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(packageRoot, 'build', 'runtime', 'vendor', 'cloudflared');
const binaryPath = path.join(outputDirectory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const releaseRoot = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;

fs.mkdirSync(outputDirectory, { recursive: true });
const payload = await download(`${releaseRoot}/${target.asset}`, target.sha256);
if (target.archive) {
  const archivePath = path.join(outputDirectory, target.asset);
  fs.writeFileSync(archivePath, payload);
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', outputDirectory, 'cloudflared'], { stdio: 'inherit' });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
} else {
  fs.writeFileSync(binaryPath, payload);
}
fs.chmodSync(binaryPath, 0o755);

const license = await download(
  `https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`,
  LICENSE_SHA256,
);
fs.writeFileSync(path.join(outputDirectory, 'LICENSE'), license);
fs.writeFileSync(path.join(outputDirectory, 'VERSION'), `${VERSION}\n`);
console.log(`[doompi-desktop] bundled cloudflared ${VERSION} for ${targetName}`);
