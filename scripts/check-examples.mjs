#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginNames = ['blog-writing', 'development', 'testing'];
const workflowNames = ['blog-writing.workflow.yml', 'dev-feature.workflow.yml', 'dev-fix.workflow.yml'];
const defaultPackagePaths = [
  './packages/minor/doompi-help',
  './packages/default/doompi-hook',
  './packages/minor/doompi-goal',
  './packages/minor/doompi-voice',
  './packages/default/doompi-runner',
  './packages/default/doompi-read',
  './packages/default/doompi-grep',
  './packages/default/doompi-edit',
  './packages/default/doompi-file-edit',
  './packages/default/doompi-autocompact',
  './packages/minor/doompi-loop',
  './packages/minor/doompi-plan',
  './packages/minor/doompi-workflow',
  './packages/default/doompi-log',
  './packages/default/doompi-mcp',
];

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) fail(`Missing JSON file: ${relativePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} must be [${expected.join(', ')}]`);
  }
}

function assertExactNames(actual, expected, label) {
  const sorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertArrayEqual(sorted, expectedSorted, label);
}

function packageSpecifiers(entries) {
  return Array.isArray(entries) ? entries.map((entry) => (typeof entry === 'string' ? entry : entry.name)) : entries;
}

function validatePlugins() {
  const pluginsRoot = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsRoot)) fail('Missing plugins directory');
  const directories = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assertExactNames(directories, pluginNames, 'Direct plugin directories');

  for (const pluginName of pluginNames) {
    const codexPath = path.join('plugins', pluginName, '.codex-plugin', 'plugin.json');
    const claudePath = path.join('plugins', pluginName, '.claude-plugin', 'plugin.json');
    const codexManifest = readJson(codexPath);
    const claudeManifest = readJson(claudePath);
    if (codexManifest.name !== pluginName) fail(`${codexPath} name must be "${pluginName}"`);
    if (claudeManifest.name !== pluginName) fail(`${claudePath} name must be "${pluginName}"`);
  }
}

function localMarketplaceSource(entry, label) {
  if (typeof entry.source === 'string') return entry.source;
  if (
    entry.source &&
    typeof entry.source === 'object' &&
    !Array.isArray(entry.source) &&
    entry.source.source === 'local' &&
    typeof entry.source.path === 'string'
  ) {
    return entry.source.path;
  }
  fail(`${label} must use a local string source or a local source object`);
}

function validateMarketplace(relativePath) {
  const marketplace = readJson(relativePath);
  if (!Array.isArray(marketplace.plugins)) fail(`${relativePath} must contain a plugins array`);
  assertExactNames(
    marketplace.plugins.map((entry) => entry?.name),
    pluginNames,
    `${relativePath} plugin names`,
  );

  for (const pluginName of pluginNames) {
    const entry = marketplace.plugins.find((candidate) => candidate?.name === pluginName);
    const source = localMarketplaceSource(entry, `${relativePath} entry "${pluginName}"`);
    const resolved = path.resolve(root, source);
    const expected = path.join(root, 'plugins', pluginName);
    if (resolved !== expected) {
      fail(`${relativePath} entry "${pluginName}" must resolve to plugins/${pluginName}`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      fail(`${relativePath} entry "${pluginName}" resolves to a missing directory`);
    }
  }
}

async function validateDomains() {
  const domainsModule = path.join(root, 'packages', 'core', 'doompi-config', 'dist', 'domains.mjs');
  if (!fs.existsSync(domainsModule)) {
    fail('Built DoomPi domain loader is unavailable. Run pnpm build before checking examples.');
  }
  const { loadDomains } = await import(pathToFileURL(domainsModule).href);
  const manifest = loadDomains(root, root);
  assertArrayEqual(manifest.defaultDomains, ['development', 'testing'], 'defaultDomains');
  assertArrayEqual(manifest.plugins?.roots, [path.join(root, 'plugins')], 'plugins.roots');
  assertExactNames(Object.keys(manifest.domains ?? {}), ['blog', 'development', 'testing'], 'Domain names');
  assertArrayEqual(manifest.domains?.development?.plugins, ['development'], 'domains.development.plugins');
  assertArrayEqual(manifest.domains?.testing?.plugins, ['testing'], 'domains.testing.plugins');
  assertArrayEqual(manifest.domains?.blog?.plugins, ['blog-writing'], 'domains.blog.plugins');
  assertExactNames(Object.keys(manifest.aliases ?? {}), ['engineering'], 'Domain aliases');
  assertArrayEqual(manifest.aliases?.engineering, ['development', 'testing'], 'aliases.engineering');
}

async function validateMajorMode() {
  const majorModesModule = path.join(root, 'packages', 'core', 'doompi-config', 'dist', 'majorModes.mjs');
  if (!fs.existsSync(majorModesModule)) {
    fail('Built DoomPi major mode loader is unavailable. Run pnpm build before checking examples.');
  }
  const { loadMajorModesConfig } = await import(pathToFileURL(majorModesModule).href);
  const config = loadMajorModesConfig(root, root);
  if (config.defaultMajorMode !== 'copilot') fail('defaultMajorMode must be "copilot"');
  assertExactNames(Object.keys(config.majorMode ?? {}), ['copilot', 'examples', 'minimal'], 'Major mode names');
  assertArrayEqual(config.majorMode?.minimal?.layers, ['team', 'task'], 'majorMode.minimal.layers');
  assertArrayEqual(config.majorMode?.copilot?.layers, ['team', 'ask-user', 'task'], 'majorMode.copilot.layers');
  assertArrayEqual(config.majorMode?.examples?.layers, [], 'majorMode.examples.layers');
  assertArrayEqual(packageSpecifiers(config.default?.packages), defaultPackagePaths, 'default.packages');
  assertArrayEqual(
    packageSpecifiers(config.layers?.team?.packages),
    ['./layers/team/doompi-team'],
    'layers.team.packages',
  );
  assertArrayEqual(
    packageSpecifiers(config.layers?.['ask-user']?.packages),
    ['./layers/ask-user/doompi-user-feedback'],
    'layers.ask-user.packages',
  );
  assertArrayEqual(
    packageSpecifiers(config.layers?.task?.packages),
    ['./layers/task/doompi-task'],
    'layers.task.packages',
  );
}

function runCheck(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} failed${output ? `:\n${output}` : ''}`);
  }
}

function validateWorkflows() {
  const workflowDirectory = path.join(root, 'automations', 'workflows');
  if (!fs.existsSync(workflowDirectory)) fail('Missing automations/workflows directory');
  const workflows = fs
    .readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.workflow.yml'))
    .map((entry) => entry.name);
  assertExactNames(workflows, workflowNames, 'Workflow files');

  const workflowBinary = path.join(root, 'node_modules', '.bin', 'workflow-mcp');
  if (!fs.existsSync(workflowBinary)) fail('workflow-mcp is unavailable. Install workspace dependencies first.');
  const workflowHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-workflow-check-'));
  try {
    const env = { ...process.env, WORKFLOW_MCP_HOME: workflowHome };
    runCheck(workflowBinary, ['list-workflows', workflowDirectory, '--format', 'json'], 'Workflow discovery', { env });
    for (const workflowName of workflowNames) {
      const workspace = `doompi-examples-check-${process.pid}-${workflowName.replace(/\W+/g, '-')}`;
      runCheck(
        workflowBinary,
        [
          'run-workflow',
          path.join(workflowDirectory, workflowName),
          '--dry-run',
          '--skip-launch',
          '--workspace',
          workspace,
          '--prompt',
          'Validate the example',
        ],
        `Dry-run ${workflowName}`,
        { env },
      );
    }
  } finally {
    fs.rmSync(workflowHome, { recursive: true, force: true });
  }
}

function validateDoomPiExplain() {
  const cliPath = path.join(root, 'packages', 'core', 'doompi', 'dist', 'bin', 'cli.mjs');
  if (!fs.existsSync(cliPath)) fail('Built DoomPi CLI is unavailable. Run pnpm build before checking examples.');
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-examples-check-'));
  try {
    const env = {
      ...process.env,
      HOME: isolatedHome,
      PI_CODING_AGENT_DIR: path.join(isolatedHome, '.pi', 'agent'),
    };
    for (const domains of ['engineering', 'blog']) {
      runCheck(
        process.execPath,
        [cliPath, '--cwd', root, '--major-mode', 'examples', '--domains', domains, '--explain'],
        `DoomPi explain for ${domains}`,
        { env },
      );
    }
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

validatePlugins();
validateMarketplace('.agents/plugins/marketplace.json');
validateMarketplace('.claude-plugin/marketplace.json');
await validateDomains();
await validateMajorMode();
validateWorkflows();
validateDoomPiExplain();

process.stdout.write('Example plugins, domains, marketplaces, and workflows passed validation.\n');
