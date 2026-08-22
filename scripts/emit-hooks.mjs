#!/usr/bin/env node
// Renders the frontend hook files from the canonical registry at .doom/hooks.yaml.
//
//   node scripts/emit-hooks.mjs --check   exit 1 if a file is out of date
//   node scripts/emit-hooks.mjs --write   regenerate the files in place
//
// Claude Code reads .claude/settings.json before any harness code runs, so it
// stays checked in and generated rather than produced at launch. Pi reads
// hooks.yaml directly through @agimon-ai/doompi-hook
// and needs no emitted file.
//
// In .claude/settings.json only the "hooks" VALUE comes from the registry. Every
// other key keeps its value and position, but the file is rewritten with
// JSON.stringify, so hand-applied formatting gets normalized. Editing the other
// keys by hand is still fine.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// yaml is a transitive dependency here rather than a root devDependency, so it
// is resolved through a package that declares it directly.
const { parse } = createRequire(path.join(REPO_ROOT, 'packages/core/doompi/package.json'))('yaml');
const REGISTRY_PATH = path.join(REPO_ROOT, '.doom', 'hooks.yaml');
const CLAUDE_SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');

// Event order in the emitted file. Purely cosmetic (each event is an independent
// key) but pinned so regeneration produces a stable diff.
const CLAUDE_EVENT_ORDER = [
  'SessionStart',
  'PreToolUse',
  'Stop',
  'Notification',
  'StopFailure',
  'PostToolUse',
  'PostToolBatch',
  'SessionEnd',
];
const HOOK_GROUPS_ENV = 'DOOMPI_HOOK_GROUPS';

export function loadRegistry(registryPath = REGISTRY_PATH) {
  const registry = parse(fs.readFileSync(registryPath, 'utf8'));
  if (!registry?.groups || typeof registry.groups !== 'object') {
    throw new Error(`${registryPath} has no "groups" map`);
  }
  return registry;
}

// Flattens the registry into one row per (hook, frontend) binding, carrying the
// group and file position so ties in `order` resolve deterministically.
export function bindingsFor(registry, frontend) {
  const rows = [];
  let position = 0;
  for (const [groupId, group] of Object.entries(registry.groups)) {
    for (const hook of group.hooks ?? []) {
      const binding = hook[frontend];
      position += 1;
      if (!binding) continue;
      if (!hook.event) throw new Error(`Hook ${hook.id} is missing "event"`);
      if (!binding.command) throw new Error(`Hook ${hook.id} (${frontend}) is missing "command"`);
      rows.push({
        id: hook.id,
        groupId,
        core: group.core === true,
        event: hook.event,
        matcher: binding.matcher,
        command: binding.command,
        timeout: binding.timeout,
        order: binding.order ?? 0,
        position,
      });
    }
  }
  return rows;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// A non-core group runs when DOOMPI_HOOK_GROUPS is unset, or when it lists the
// group. Core groups always run.
function gatedCommand(row) {
  if (row.core) return row.command;
  const selectedGroup = shellQuote(`,${row.groupId},`);
  return `if [ -z "\${${HOOK_GROUPS_ENV}+x}" ] || printf ',%s,' "$${HOOK_GROUPS_ENV}" | grep -Fq ${selectedGroup}; then ${row.command}; fi`;
}

// Groups bindings into the { event: [{ matcher, hooks: [...] }] } shape the
// frontend expects. Hooks sharing an (event, matcher) run in sequence, so they
// are sorted by `order` then file position. Matcher blocks appear in first-seen
// order, which is not load-bearing.
function renderHookTree(rows, eventOrder) {
  const tree = {};
  const events = [...new Set(rows.map((row) => row.event))].sort((a, b) => {
    const left = eventOrder.indexOf(a);
    const right = eventOrder.indexOf(b);
    if (left === -1 || right === -1) throw new Error(`Unknown event "${left === -1 ? a : b}"`);
    return left - right;
  });

  for (const event of events) {
    const eventRows = rows.filter((row) => row.event === event);
    const matchers = [...new Set(eventRows.map((row) => row.matcher ?? null))];
    tree[event] = matchers.map((matcher) => ({
      ...(matcher === null ? {} : { matcher }),
      hooks: eventRows
        .filter((row) => (row.matcher ?? null) === matcher)
        .sort((a, b) => a.order - b.order || a.position - b.position)
        .map((row) => ({
          type: 'command',
          command: gatedCommand(row),
          ...(row.timeout === undefined ? {} : { timeout: row.timeout }),
        })),
    }));
  }
  return tree;
}

export function renderClaudeHooks(registry) {
  return renderHookTree(bindingsFor(registry, 'claude'), CLAUDE_EVENT_ORDER);
}

// Only the "hooks" value is owned by the registry. Everything else in
// settings.json is hand-maintained and is read back and re-serialized unchanged.
function renderClaudeSettings(registry) {
  const settings = fs.existsSync(CLAUDE_SETTINGS_PATH) ? JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) : {};
  settings.hooks = renderClaudeHooks(registry);
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) {
    process.stderr.write('Usage: emit-hooks.mjs --check | --write\n');
    return 2;
  }

  const registry = loadRegistry();
  const targets = [
    { label: '.claude/settings.json', filePath: CLAUDE_SETTINGS_PATH, content: renderClaudeSettings(registry) },
  ];

  let drifted = 0;
  for (const target of targets) {
    const current = fs.existsSync(target.filePath) ? fs.readFileSync(target.filePath, 'utf8') : null;
    if (current === target.content) {
      if (check) process.stdout.write(`ok   ${target.label}\n`);
      continue;
    }
    drifted += 1;
    if (check) {
      process.stdout.write(`DRIFT ${target.label}\n`);
      continue;
    }
    fs.writeFileSync(target.filePath, target.content);
    process.stdout.write(`wrote ${target.label}\n`);
  }

  if (check && drifted > 0) {
    process.stderr.write(`\n${drifted} file(s) out of date. Run: node scripts/emit-hooks.mjs --write\n`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
