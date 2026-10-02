import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  artifactNames,
  assertAppleCredentials,
  checksumContents,
  createBuildEnvironment,
  createBuildManifest,
  readBuildManifest,
  parseArguments,
  releaseTag,
  uploadDraft,
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

test('notarization uses the verified keychain profile without raw Apple credentials', () => {
  const identity = 'Developer ID Application: Example (TEAMID1234)';
  const env = { CSC_NAME: identity, APPLE_TEAM_ID: 'TEAMID1234', NOTARYTOOL_KEYCHAIN_PROFILE: 'agimon' };
  const calls = [];
  assert.deepEqual(
    assertAppleCredentials(env, (command, args) => {
      calls.push([command, args]);
      return { stdout: `1) ABCDEF "${identity}"` };
    }),
    { identity, teamId: 'TEAMID1234', profile: 'agimon' },
  );
  assert.deepEqual(calls, [
    ['security', ['find-identity', '-v', '-p', 'codesigning']],
    ['xcrun', ['notarytool', 'history', '--keychain-profile', 'agimon', '--output-format', 'json']],
  ]);
  assert.throws(() => assertAppleCredentials({ ...env, APPLE_TEAM_ID: '' }), /APPLE_TEAM_ID/);
  assert.throws(
    () =>
      assertAppleCredentials(env, () => {
        throw new Error('profile unavailable');
      }),
    /profile unavailable/,
  );
  const competing = Object.fromEntries(
    [
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'APPLE_KEYCHAIN',
    ].map((name) => [name, 'unused']),
  );
  const build = createBuildEnvironment(identity, '/artifacts', 'agimon', { ...env, ...competing });
  assert.equal(build.APPLE_KEYCHAIN_PROFILE, 'agimon');
  assert.equal(build.NOTARYTOOL_KEYCHAIN_PROFILE, 'agimon');
  assert.equal(build.CSC_NAME, identity);
  assert.equal(build.DOOMPI_DESKTOP_REQUIRE_SIGNING, '1');
  for (const name of Object.keys(competing)) assert.equal(build[name], undefined);
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

function buildFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-versioned-release-'));
  try {
    const version = '0.0.1-alpha.0';
    const commit = 'a'.repeat(40);
    const builtAt = new Date('2026-01-02T03:04:05.000Z');
    const names = artifactNames(version, commit, builtAt);
    const artifacts = { names };
    for (const kind of ['dmg', 'zip', 'checksum']) artifacts[kind] = path.join(directory, names[kind]);
    fs.writeFileSync(artifacts.dmg, 'signed dmg');
    fs.writeFileSync(artifacts.zip, 'stapled zip');
    fs.writeFileSync(artifacts.checksum, checksumContents(artifacts));
    const manifest = createBuildManifest(artifacts, version, commit, 'TEAMID1234', builtAt);
    artifacts.manifest = path.join(directory, 'desktop-build.json');
    artifacts.names.manifest = 'desktop-build.json';
    fs.writeFileSync(artifacts.manifest, JSON.stringify(manifest));
    return run({ directory, manifest, artifacts });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function assetInventory(artifacts) {
  return Object.entries(artifacts.names).map(([kind, name], index) => ({
    id: index + 1,
    name,
    size: fs.statSync(artifacts[kind]).size,
    digest: `sha256:${createHash('sha256').update(fs.readFileSync(artifacts[kind])).digest('hex')}`,
  }));
}

function fakeGitHub(manifest, artifacts, state = {}) {
  const calls = [];
  let ref = state.ref ?? null;
  let release = state.release ?? null;
  let assets = state.assets ?? [];
  const inventory = assetInventory(artifacts);
  const client = {
    optionalApi(endpoint) {
      calls.push(['GET', endpoint]);
      return endpoint.includes('/git/ref/') ? ref : release;
    },
    api(endpoint, options = {}) {
      calls.push([options.method ?? 'GET', endpoint, options.input]);
      if (endpoint.endsWith('/git/refs')) ref = { object: { type: 'commit', sha: options.input.sha } };
      else if (endpoint.endsWith('/releases') && options.method === 'POST') {
        release = { id: 5, html_url: 'https://github.com/example/draft', ...options.input };
        return release;
      } else if (endpoint.includes('/assets?')) return assets;
      else throw new Error(`Unexpected API call ${endpoint}`);
      return ref;
    },
    command(file, args) {
      calls.push([file, args]);
      assert.equal(file, 'gh');
      assert.equal(args[0], 'release');
      assert.equal(args[1], 'upload');
      const requested = new Set(args.slice(3, -2).map((entry) => path.basename(entry)));
      assets = [...assets, ...inventory.filter((asset) => requested.has(asset.name))];
    },
  };
  return { client, calls, state: () => ({ ref, release, assets }) };
}

test('manifest roundtrip binds exact final files and version identity', () =>
  buildFixture(({ directory, manifest, artifacts }) => {
    assert.deepEqual(readBuildManifest(directory).manifest, manifest);
    assert.equal(releaseTag(manifest.version), 'desktop-v0.0.1-alpha.0');
    fs.writeFileSync(artifacts.zip, 'different zip');
    assert.throws(() => readBuildManifest(directory), /checksum mismatch/);
  }));

test('manifest rejects paths, symlinks and incompatible identities before external operations', () =>
  buildFixture(({ directory, manifest, artifacts }) => {
    for (const bad of [
      { ...manifest, repository: 'other/repo' },
      { ...manifest, target: 'darwin-x64' },
      { ...manifest, version: 'invalid' },
      { ...manifest, files: { ...manifest.files, dmg: { ...manifest.files.dmg, name: '../outside.dmg' } } },
    ]) {
      fs.writeFileSync(artifacts.manifest, JSON.stringify(bad));
      assert.throws(() => readBuildManifest(directory));
    }
    fs.writeFileSync(artifacts.manifest, JSON.stringify(manifest));
    const original = `${artifacts.zip}.original`;
    fs.renameSync(artifacts.zip, original);
    fs.symlinkSync(original, artifacts.zip);
    assert.throws(() => readBuildManifest(directory), /regular file/);
  }));

test('versioned draft creates a tag once and uploads without building or publishing', () =>
  buildFixture(({ manifest, artifacts }) => {
    const remote = fakeGitHub(manifest, artifacts);
    assert.equal(uploadDraft(manifest, artifacts, remote.client), 'https://github.com/example/draft');
    const { ref, release, assets } = remote.state();
    assert.equal(ref.object.sha, manifest.commit);
    assert.equal(release.draft, true);
    assert.equal(release.prerelease, true);
    assert.equal(release.make_latest, 'false');
    assert.equal(assets.length, 4);
    assert.equal(remote.calls.filter(([method]) => method === 'POST').length, 2);
    assert.equal(
      remote.calls.some(([method]) => ['PATCH', 'DELETE', 'pnpm', 'git'].includes(method)),
      false,
    );
  }));

test('matching draft retries upload only missing assets, complete retries write nothing', () =>
  buildFixture(({ manifest, artifacts }) => {
    const first = fakeGitHub(manifest, artifacts);
    uploadDraft(manifest, artifacts, first.client);
    const state = first.state();
    const retry = fakeGitHub(manifest, artifacts, { ...state, assets: state.assets.slice(0, 2) });
    uploadDraft(manifest, artifacts, retry.client);
    const command = retry.calls.find(([file]) => file === 'gh');
    assert.equal(command[1].includes(artifacts.dmg), false);
    assert.equal(command[1].includes(artifacts.zip), false);
    assert.equal(command[1].includes(artifacts.checksum), true);
    const complete = fakeGitHub(manifest, artifacts, retry.state());
    uploadDraft(manifest, artifacts, complete.client);
    assert.equal(
      complete.calls.some(([method]) => ['POST', 'PATCH', 'DELETE', 'gh'].includes(method)),
      false,
    );
  }));

test('conflicts and published releases fail before mutations', () =>
  buildFixture(({ manifest, artifacts }) => {
    const first = fakeGitHub(manifest, artifacts);
    uploadDraft(manifest, artifacts, first.client);
    const state = first.state();
    for (const conflict of [
      { ...state, ref: { object: { type: 'commit', sha: 'b'.repeat(40) } } },
      { ...state, release: { ...state.release, draft: false } },
      { ...state, release: { ...state.release, body: 'another generation' } },
      { ...state, assets: [{ ...state.assets[0], digest: `sha256:${'0'.repeat(64)}` }] },
      { ...state, assets: [{ ...state.assets[0], name: 'unexpected' }] },
    ]) {
      const retry = fakeGitHub(manifest, artifacts, conflict);
      assert.throws(() => uploadDraft(manifest, artifacts, retry.client));
      assert.equal(
        retry.calls.some(([method]) => ['POST', 'PATCH', 'DELETE', 'gh'].includes(method)),
        false,
      );
    }
  }));

test('remote assets lacking digest require verified downloaded bytes, not size alone', () =>
  buildFixture(({ artifacts }) => {
    const assets = assetInventory(artifacts);
    const undigested = assets.map(({ digest: _digest, ...asset }) => asset);
    assert.throws(() => verifyRemoteAssets(undigested, artifacts), /unverifiable/);
    assert.doesNotThrow(() =>
      verifyRemoteAssets(undigested, artifacts, (asset) => assets.find((item) => item.id === asset.id).digest),
    );
  }));

test('build and upload commands require distinct explicit artifact directories', () => {
  assert.deepEqual(parseArguments(['build', '--out', '/tmp/artifacts']), {
    mode: 'build',
    directory: '/tmp/artifacts',
  });
  assert.deepEqual(parseArguments(['upload', '--from', '/tmp/artifacts']), {
    mode: 'upload',
    directory: '/tmp/artifacts',
  });
  for (const args of [[], ['build', '--from', '/tmp/a'], ['upload', '--out', '/tmp/a'], ['upload', '--from', '../a']]) {
    assert.throws(() => parseArguments(args), /Usage/);
  }
});

test('packaging records full version and commit inside the signed plist configuration', () => {
  if (!['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(`${process.platform}-${process.arch}`)) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-builder-identity-'));
  try {
    const record = path.join(directory, 'builder-args.json');
    const commit = 'a'.repeat(40);
    fs.writeFileSync(path.join(directory, 'git'), `#!/bin/sh\nprintf '${commit}\\n'\n`, { mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, 'npx'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.BUILDER_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    runCommand(process.execPath, ['packages/clients/doompi-desktop/scripts/packageElectron.mjs'], {
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, BUILDER_ARGS_FILE: record },
    });
    const args = JSON.parse(fs.readFileSync(record, 'utf8'));
    const version = JSON.parse(fs.readFileSync('packages/clients/doompi-desktop/package.json', 'utf8')).version;
    assert.ok(args.includes(`--config.mac.extendInfo.DoomPiVersion=${version}`));
    assert.ok(args.includes(`--config.mac.extendInfo.DoomPiCommit=${commit}`));
    assert.ok(args.includes('never'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('release versions reject noncanonical numeric prerelease identifiers', () => {
  assert.throws(() => releaseTag('0.0.1-alpha.01'), /noncanonical/);
  assert.throws(() => releaseTag('01.0.1'), /valid release version/);
});
