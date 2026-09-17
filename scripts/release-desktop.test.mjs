import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactNames, parseDeveloperIdIdentity, redactSecrets } from './release-desktop.mjs';

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

test('release errors redact credential values', () => {
  const env = {
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret-password',
  };
  assert.equal(redactSecrets('developer@example.com secret-password', env), '[redacted] [redacted]');
});
