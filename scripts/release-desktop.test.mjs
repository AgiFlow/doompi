import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  artifactNames,
  checksumContents,
  parseDeveloperIdIdentity,
  redactSecrets,
  runCommand,
  verifyRemoteAssets,
} from './release-desktop.mjs';

test('artifact names are generation-specific and safe for GitHub assets', () => {
  const names = artifactNames(
    '0.0.1-alpha.0',
    '0123456789012345678901234567890123456789',
    new Date('2026-01-02T03:04:05.000Z'),
  );
  assert.deepEqual(names, {
    dmg: 'DoomPi-0.0.1-alpha.0-arm64-012345678901-20260102T030405Z.dmg',
    zip: 'DoomPi-0.0.1-alpha.0-arm64-012345678901-20260102T030405Z.zip',
    checksum: 'DoomPi-0.0.1-alpha.0-arm64-012345678901-20260102T030405Z.sha256',
  });
});

test('checksum contents are calculated from the final artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-release-test-'));
  try {
    const dmg = path.join(directory, 'DoomPi.dmg');
    const zip = path.join(directory, 'DoomPi.zip');
    fs.writeFileSync(dmg, 'final notarized dmg');
    fs.writeFileSync(zip, 'stapled app zip');
    const artifacts = { dmg, zip, names: { dmg: 'DoomPi.dmg', zip: 'DoomPi.zip' } };
    const digest = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    assert.equal(checksumContents(artifacts), `${digest(dmg)}  DoomPi.dmg\n${digest(zip)}  DoomPi.zip\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('remote asset verification checks current sizes and available digests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-release-remote-test-'));
  try {
    const dmg = path.join(directory, 'DoomPi.dmg');
    const zip = path.join(directory, 'DoomPi.zip');
    const checksum = path.join(directory, 'DoomPi.sha256');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(checksum, 'checksum');
    const artifacts = {
      dmg,
      zip,
      checksum,
      names: { dmg: 'DoomPi.dmg', zip: 'DoomPi.zip', checksum: 'DoomPi.sha256' },
    };
    const digest = (filePath) => `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
    const assets = [
      { name: 'DoomPi.dmg', size: fs.statSync(dmg).size, digest: digest(dmg) },
      { name: 'DoomPi.zip', size: fs.statSync(zip).size, digest: digest(zip) },
      { name: 'DoomPi.sha256', size: fs.statSync(checksum).size, digest: digest(checksum) },
    ];
    assert.doesNotThrow(() => verifyRemoteAssets(assets, artifacts));
    assert.throws(
      () =>
        verifyRemoteAssets(
          assets.map((asset) => ({ ...asset, size: asset.size + 1 })),
          artifacts,
        ),
      /size/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('identity validation requires the installed Developer ID certificate and team', () => {
  const identity = 'Developer ID Application: Example (TEAMID1234)';
  const output = `  1) ${identity}\n     0123456789 "${identity}"\n  1 valid identity found`;
  assert.equal(parseDeveloperIdIdentity(identity, output, 'TEAMID1234'), identity);
  assert.throws(() => parseDeveloperIdIdentity(identity, output, 'OTHERTEAM12'), /does not match/);
  assert.throws(
    () => parseDeveloperIdIdentity('Apple Development: Example (TEAMID1234)', output, 'TEAMID1234'),
    /Developer ID Application/,
  );
});

test('command failures redact credential values', () => {
  const env = {
    ...process.env,
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret-password',
  };
  assert.throws(
    () =>
      runCommand(
        process.execPath,
        ['-e', 'process.stderr.write(process.env.APPLE_APP_SPECIFIC_PASSWORD); process.exit(3)'],
        { env },
      ),
    /\[redacted\]/,
  );
  assert.equal(redactSecrets('developer@example.com secret-password', env), '[redacted] [redacted]');
});
