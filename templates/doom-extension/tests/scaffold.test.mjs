import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Use the scaffold tool's own template dependencies and strict rendering.
const require = createRequire(import.meta.resolve('@agiflowai/scaffold-mcp'));
const { Liquid } = require('liquidjs');
const { load } = require('js-yaml');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = load(await readFile(path.join(root, 'scaffold.yaml'), 'utf8'));
const engine = new Liquid({ strictVariables: true, strictFilters: true });
const words = (value) =>
  String(value)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
for (const [name, filter] of Object.entries({
  camelCase: (value) =>
    words(value)
      .map((word, index) => (index ? capitalize(word) : word))
      .join(''),
  pascalCase: (value) => words(value).map(capitalize).join(''),
  kebabCase: (value) => words(value).join('-'),
  snakeCase: (value) => words(value).join('_'),
  upperCase: (value) => words(value).join('_').toUpperCase(),
  upper: (value) => String(value).toUpperCase(),
}))
  engine.registerFilter(name, filter);

const variables = {
  packageName: 'doompi-fixture',
  packageDescription: 'Inspect fixture data',
  packageKeyword: 'fixture-data',
  commandName: 'doom-fixture',
  commandDescription: 'Inspect fixture',
  author: 'Test Author',
  copyrightYear: '2026',
  methodName: 'readSelection',
  serviceName: 'fixturePolicy',
  scope: 'session',
  promptName: 'doompi-use-fixture-extra',
  promptDescription: 'Use fixture extra',
  serviceDescription: 'Read fixture',
  restrictionName: 'fixtureMode',
  restrictionDescription: 'Hide writes',
  facetName: 'fixture',
  apiModule: '../../../../../services/fixtureApi',
  scopeReason: 'the data belongs to the session',
  providerName: 'fixture-metrics',
  providerDescription: 'Publish metrics',
  capabilityName: 'clock',
  implementationName: 'system',
  capabilityDescription: 'Read clock',
  pluginId: 'fixture',
  topic: 'fixture',
  channelName: 'fixture_items',
  toolName: 'fixture_read',
  toolSummary: 'Read fixture',
};

async function render(feature) {
  const result = new Map();
  for (const mapping of feature.includes) {
    const [source, target = source] = mapping.split('->');
    const filename = path.join(root, source);
    const template = await readFile(filename, 'utf8').catch(() => readFile(`${filename}.liquid`, 'utf8'));
    result.set(await engine.parseAndRender(target, variables), await engine.parseAndRender(template, variables));
  }
  return result;
}

await test('every scaffold renders and all source imports resolve across the composed features', async () => {
  const files = new Map();
  for (const feature of [...config.boilerplate, ...config.features]) {
    for (const [filename, content] of await render(feature)) {
      assert.doesNotMatch(filename, /^src\/(?:adapters|containers?|commands|controllers|providers|tools)\//u);
      assert.doesNotMatch(filename, /^src\/exports\/[^/]+\//u);
      assert.doesNotMatch(filename, /\/extra\.(?:cli|server|web)\.[^.]+$/u);
      assert.doesNotMatch(filename, /\/(?:[^/]+-(?:catalog|optional)|tool-collection)\//u);
      files.set(filename, content);
    }
  }
  for (const [filename, content] of files) {
    if (!/\.tsx?$/u.test(filename)) continue;
    for (const match of content.matchAll(/from\s+['"](?<specifier>\.[^'"]+)['"]/gu)) {
      const specifier = match.groups.specifier;
      assert.doesNotMatch(specifier, /(?:\/index|\.tsx?)$/u, filename);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      // generated/ is written by the build, not by the scaffold, so a test
      // importing a host entry has nothing to resolve against here.
      if (target.startsWith('generated/')) continue;
      assert.ok(
        [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`].some((candidate) => files.has(candidate)),
        `${filename} imports missing ${specifier}`,
      );
    }
    if (filename.startsWith('src/exports/')) {
      assert.doesNotMatch(content, /from ['"][^'"]*\/extensions\//u);
      assert.doesNotMatch(content, /\b(?:function|class|const|let)\b/u);
    }
    if (filename.startsWith('src/extensions/')) {
      assert.doesNotMatch(content, /\b(?:setup|teardown)\s*[:(]/u);
      assert.doesNotMatch(
        content,
        /\b(?:registerTool|registerCommand|registerApi|registerChannel|connectDoomCordisHost)\s*\(/u,
      );
      const privateFile = filename.split('/').some((segment) => segment.startsWith('_'));
      const colocatedApiFile = filename.includes('/api/') && !/\/route(?:\.[^.]+)?\.tsx?$/u.test(filename);
      if (/\.tsx?$/u.test(filename) && !privateFile && !colocatedApiFile) {
        assert.match(content, /\bexport\s+default\s+define[A-Z][A-Za-z0-9]*\s*\(/u, filename);
        assert.doesNotMatch(content, /\bexport\s+(?!default\b)/u, filename);
      }
    }
  }
});

await test('the base package routes its contributions and generates its host entries', async () => {
  const files = await render(config.boilerplate[0]);
  const manifest = JSON.parse(files.get('package.json'));
  assert.deepEqual(manifest.pi.extensions, ['./dist/extensions/pi.mjs']);
  assert.equal(
    manifest.peerDependencies['@earendil-works/pi-coding-agent'],
    manifest.devDependencies['@earendil-works/pi-coding-agent'],
  );

  // No hand-written host entry: the build writes all three into generated/,
  // which the package gitignores.
  assert.ok(!files.has('src/extensions/pi.ts'));
  assert.match(files.get('.gitignore'), /^\/generated$/mu);
  assert.match(files.get('tsdown.config.ts'), /doompiExtension\(\)/u);
  assert.equal(manifest.devDependencies['@agimon-ai/doompi-build'], 'workspace:*');

  // The command is a routed file: its folder is the surface, its name is the
  // command, and it declares itself through the typed helper.
  const routed = [...files.keys()].find((name) => name.includes('(backend)/command/'));
  assert.ok(routed, 'expected a routed command file');
  assert.match(files.get(routed), /defineCommand\(/u);
  assert.match(files.get(routed), /@agimon-ai\/doompi-core\/extension-file/u);

  assert.ok(files.has('src/services/extensionService/index.ts'));
  assert.ok(files.has('src/services/extensionService/type.ts'));
  // src/tools is no longer a root; platform shape lives in the routed file.
  assert.ok(![...files.keys()].some((name) => name.startsWith('src/tools/')));
});
