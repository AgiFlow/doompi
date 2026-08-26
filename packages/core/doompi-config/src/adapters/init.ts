import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigDirectory } from './config.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REPOSITORY_DIRECTORY_MODE = 0o755;
const REPOSITORY_FILE_MODE = 0o644;
const DOOM_DIRECTORY = '.doom';
const UTF8_ENCODING = 'utf8';
const FILE_ALREADY_EXISTS = 'EEXIST';
const FILE_NOT_FOUND = 'ENOENT';

/** The global seed files are processed in this fixed order. */
export const GLOBAL_DOOM_SEED_FILES = ['config.yaml', 'modes.yaml', 'domains.yaml', 'profiles.yaml'] as const;

type DoomSeedFile = (typeof GLOBAL_DOOM_SEED_FILES)[number];

/** Portable defaults for a new global Doom configuration directory. */
export const DOOM_CONFIG_TEMPLATES: Readonly<Record<DoomSeedFile, string>> = {
  'config.yaml': `projectTrust: ask

# Autonomous voice is opt-in and uses an explicitly configured Pi model.
# voice:
#   autoCapture:
#     model: provider/model-id
#     startPhrases:
#       - hey doom
#     stopPhrases:
#       - stop speaking
#     utteranceIdleMs: 3000
#     # Long prompts only: open a draft, keep talking, then send it in one piece.
#     # Short utterances are delivered as you finish them and need no phrase.
#     composeOpenPhrases:
#       - hey doom
#     composeSendPhrases:
#       - that's it
#     composeCancelPhrases:
#       - scratch that
#     # Endpoint window while a draft collects, so a short command lands on its own.
#     composeUtteranceIdleMs: 1200
#     # Silence before Voice reminds you a draft is open. 0 turns the reminder off.
#     composeNudgeMs: 10000
#     tts:
#       engine: macos-say
#       voice: Samantha
#       rate: 190
`,
  'modes.yaml': `# A layer is a reusable named bundle of packages, built-in or local extensions,
# and hook groups. Major modes below choose which layers load together for a session.
#
# Layers and modes defined here apply to every repository. A repository's own
# .doom/modes.yaml is read after this file and replaces any layer or mode of the
# same name, so a repository can override one entry without restating the rest.
#
# Add a layer by giving it a unique name under layers. Local Pi scripts belong
# under extensions, while installed Pi packages belong under packages:
#   review-tools:
#     extensions:
#       - './extensions/local-review.ts'
#     packages:
#       - '@scope/review-extension'
# A bare extension name selects a DoomPi built-in. A path beginning with ./ or
# ../ loads a custom script or extension directory. A bare package loads its
# ordered package.json pi.extensions entries, while an exported subpath selects
# one adapter. Relative paths resolve beside this file here (~/.pi/.doom), or
# from the repository root in .doom/modes.yaml.
#
# Use a package mapping when that package accepts configuration. Configuration
# belongs under the package entry that consumes it, not beside packages.
# The top-level default bundle loads before every major mode. Replace this whole
# packages list to customize the distribution defaults. DoomPi core packages
# remain active independently of this list.
default:
  packages:
    - '@agimon-ai/doompi-help'
    - '@agimon-ai/doompi-hook'
    - '@agimon-ai/doompi-goal'
    - '@agimon-ai/doompi-voice'
    - '@agimon-ai/doompi-runner'
    - '@agimon-ai/doompi-read'
    - '@agimon-ai/doompi-grep'
    - '@agimon-ai/doompi-edit'
    - '@agimon-ai/doompi-file-edit'
    - '@agimon-ai/doompi-autocompact'
    - '@agimon-ai/doompi-loop'
    - '@agimon-ai/doompi-plan'
    - '@agimon-ai/doompi-workflow'
    - '@agimon-ai/doompi-log'
    - '@agimon-ai/doompi-mcp'
layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        # Optional Team configuration. Uncomment and choose models available to Pi.
        # config:
        #   models:
        #     - model: openai-codex/gpt-5.6-luna
        #       thinking: xhigh
        #   # Tool names excluded from subagents launched by this package. These
        #   # remove model-visible tools while preserving hidden team transport.
        #   excludeTools: [ask_user_question, intercom, subagent]
  ask-user:
    packages:
      - '@agimon-ai/doompi-user-feedback'
  task:
    packages:
      - '@agimon-ai/doompi-task'
# A major mode explains when it should be used and names its ordered layers.
# Add another entry under majorMode, then select it with
# doompi --major-mode <name>. Change defaultMajorMode to make it the default.
defaultMajorMode: copilot
majorMode:
  minimal:
    description: Lean mode with Team delegation and persistent tasks.
    layers: [team, task]
  copilot:
    description: General-purpose coding mode with Team delegation, persistent tasks, supervised commands, and structured user feedback.
    layers: [team, ask-user, task]
  # review:
  #   description: Focused review mode for inspecting changes and reporting risks.
  #   layers: [team, task, ask-user]
`,
  'domains.yaml': `# Plugins are named once in this catalog, then selected by one or more domains.
# DoomPi automatically inspects personal and repository Codex marketplaces.
# Each configured root may also be a folder whose direct children are plugins;
# use roots: [plugins] to discover a repository plugin folder without one entry
# per plugin. Discovery never scans recursively.
defaultDomains: [default]
plugins:
  roots: []
  entries: {}
  # Local paths resolve beside this file in ~/.pi/.doom. Repository paths in a
  # repository .doom/domains.yaml resolve from that repository root.
  # entries:
  #   development:
  #     source: local
  #     path: plugins/development
  #   remote-review:
  #     source: url
  #     url: https://github.com/acme/review-plugin.git
  #     ref: v1.2.0
  #   published-review:
  #     source: npm
  #     package: '@acme/review-plugin'
  #     version: 1.2.0
# Domains carry descriptions and refer to catalog names, not filesystem paths.
domains:
  default:
    description: Shared skills and repository MCP only.
    plugins: []
  # development:
  #   description: TypeScript implementation and review tools.
  #   plugins:
  #     - development
  #     # Mapping form can load only selected resources from a shared plugin.
  #     - name: remote-review
  #       skills: [typescript]
  #       agents: [reviewer]
  #       hooks: false
  #       mcp: true
  #   # Set false only when this domain should omit shared .claude/skills.
  #   sharedSkills: false
  #   # Domain mcp is an allowlist over servers configured elsewhere, not a
  #   # request to start new ones. Listing servers here drops the tool schemas
  #   # of the ones left out, usually the largest context saving a domain can
  #   # make. Run doompi --explain to see the token cost before and after.
  #   # Filtering applies only when every selected domain declares mcp, so a
  #   # selection mixing this with a domain that omits it stays unfiltered.
  #   mcp:
  #     servers: [code-intel]
  #     proxy: [repository-search]
# Select it with doompi --domains development, or add it to defaultDomains.
#
# Aliases let one selection enable multiple domains. Replace the empty mapping
# below with entries like the commented example.
aliases: {}
# aliases:
#   work: [default, development]
`,
  'profiles.yaml': `# Profiles select a persona and optional environment defaults for a session.
# Each configured root may itself be a profile or contain direct-child profile
# folders. A folder is discovered when it contains profile.md, SOUL.md, or
# AGENTS.md; discovery never scans recursively.
profiles:
  roots: []
  entries: {}
  # Roots resolve beside this file in ~/.pi/.doom. Repository roots in a
  # repository .doom/profiles.yaml resolve from that repository root.
  # roots: [agents/acme]
  # Explicit entries override an automatically discovered folder of the same
  # name. Environment values must be strings; already exported values win.
  # entries:
  #   writer:
  #     persona: agents/special/writer
  #     env:
  #       BRAND: acme
  #       TONE: concise
# Doom Pi concatenates profile.md, SOUL.md, then AGENTS.md for the persona.
# Select one with: doompi --profile writer
`,
};

/** Standalone defaults for a repository that is trying DoomPi through DPI. */
export const REPOSITORY_DOOM_CONFIG_TEMPLATES: Readonly<Record<DoomSeedFile, string>> = {
  'config.yaml': DOOM_CONFIG_TEMPLATES['config.yaml'],
  'modes.yaml': `# Repository-local layers and major modes. These entries override personal
# entries with the same name from ~/.pi/.doom/modes.yaml.
# This repository-local default replaces the personal top-level default as one
# whole package list. Edit it to customize the standalone package baseline.
default:
  packages:
    - '@agimon-ai/doompi-help'
    - '@agimon-ai/doompi-hook'
    - '@agimon-ai/doompi-goal'
    - '@agimon-ai/doompi-voice'
    - '@agimon-ai/doompi-runner'
    - '@agimon-ai/doompi-read'
    - '@agimon-ai/doompi-grep'
    - '@agimon-ai/doompi-edit'
    - '@agimon-ai/doompi-file-edit'
    - '@agimon-ai/doompi-autocompact'
    - '@agimon-ai/doompi-loop'
    - '@agimon-ai/doompi-plan'
    - '@agimon-ai/doompi-workflow'
    - '@agimon-ai/doompi-log'
    - '@agimon-ai/doompi-mcp'
layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
  ask-user:
    packages:
      - '@agimon-ai/doompi-user-feedback'
  task:
    packages:
      - '@agimon-ai/doompi-task'
defaultMajorMode: copilot
majorMode:
  minimal:
    description: Lean mode with Team delegation and persistent tasks.
    layers: [team, task]
  copilot:
    description: General-purpose coding mode with delegation, persistent tasks, supervised commands, and structured user feedback.
    layers: [team, ask-user, task]
`,
  'domains.yaml': `# Repository-local plugin catalog and domain selection.
defaultDomains: [default]
plugins:
  roots: []
  entries: {}
domains:
  default:
    description: Shared skills and repository MCP only.
    plugins: []
aliases: {}
`,
  'profiles.yaml': `# Repository-local persona roots and environment defaults.
profiles:
  roots: []
  entries: {}
`,
};

/** Result of filling a Doom seed directory. File arrays contain names in seed order. */
export interface GlobalDoomInitResult {
  directory: string;
  created: string[];
  preserved: string[];
  /** Existing files overwritten from the template. Only ever non-empty under `force`. */
  replaced: string[];
}

export interface GlobalDoomInitOptions {
  /**
   * Overwrite existing seed files instead of preserving them.
   *
   * Off by default: init is safe to re-run, and hand-edited config is the
   * normal case rather than the exception.
   */
  force?: boolean;
}

export type RepositoryDoomInitOptions = GlobalDoomInitOptions;
export type RepositoryDoomInitResult = GlobalDoomInitResult;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function ensureDirectory(directory: string, mode: number): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (errorCode(error) !== FILE_NOT_FOUND) throw error;
    try {
      fs.mkdirSync(directory, { mode });
      stats = fs.lstatSync(directory);
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== FILE_ALREADY_EXISTS) throw mkdirError;
      stats = fs.lstatSync(directory);
    }
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to initialize through symlinked directory: ${directory}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Doom config path is not a directory: ${directory}`);
  }
}

function ensureDoomDirectory(directory: string, mode: number): void {
  ensureDirectory(path.dirname(directory), mode);
  ensureDirectory(directory, mode);
}

function classifyTarget(targetPath: string): 'missing' | 'file' {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (error) {
    if (errorCode(error) === FILE_NOT_FOUND) return 'missing';
    throw error;
  }

  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) {
    try {
      if (fs.statSync(targetPath).isFile()) return 'file';
    } catch (error) {
      throw new Error(`Doom config seed symlink is not file-like: ${targetPath}`, { cause: error });
    }
  }
  throw new Error(`Doom config seed path is not file-like: ${targetPath}`);
}

function cleanupTemporaryFile(temporaryPath: string): void {
  try {
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (errorCode(error) !== FILE_NOT_FOUND) throw error;
  }
}

function publishExclusively(targetPath: string, content: string, mode: number): boolean {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(fileDescriptor, content, UTF8_ENCODING);
    fs.fchmodSync(fileDescriptor, mode);
    fs.fsyncSync(fileDescriptor);
    const descriptorToClose = fileDescriptor;
    fileDescriptor = undefined;
    fs.closeSync(descriptorToClose);

    try {
      fs.linkSync(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (errorCode(error) === FILE_ALREADY_EXISTS && classifyTarget(targetPath) === 'file') return false;
      throw error;
    }
  } finally {
    if (fileDescriptor !== undefined) {
      const descriptorToClose = fileDescriptor;
      fileDescriptor = undefined;
      fs.closeSync(descriptorToClose);
    }
    cleanupTemporaryFile(temporaryPath);
  }
}

/**
 * Replaces a seed file with the template, atomically.
 *
 * The rename swaps the directory entry in one step, so a reader either sees the
 * whole old file or the whole new one. Renaming onto a symlinked seed replaces
 * the link rather than writing through it.
 */
function publishForcefully(targetPath: string, content: string, mode: number): void {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(fileDescriptor, content, UTF8_ENCODING);
    fs.fchmodSync(fileDescriptor, mode);
    fs.fsyncSync(fileDescriptor);
    const descriptorToClose = fileDescriptor;
    fileDescriptor = undefined;
    fs.closeSync(descriptorToClose);

    fs.renameSync(temporaryPath, targetPath);
  } finally {
    if (fileDescriptor !== undefined) {
      const descriptorToClose = fileDescriptor;
      fileDescriptor = undefined;
      fs.closeSync(descriptorToClose);
    }
    cleanupTemporaryFile(temporaryPath);
  }
}

function initializeDoomConfig(
  directory: string,
  templates: Readonly<Record<DoomSeedFile, string>>,
  options: GlobalDoomInitOptions,
  directoryMode: number,
  fileMode: number,
): GlobalDoomInitResult {
  ensureDoomDirectory(directory, directoryMode);

  const created: string[] = [];
  const preserved: string[] = [];
  const replaced: string[] = [];
  for (const fileName of GLOBAL_DOOM_SEED_FILES) {
    const targetPath = path.join(directory, fileName);
    const existed = classifyTarget(targetPath) === 'file';

    if (options.force) {
      publishForcefully(targetPath, templates[fileName], fileMode);
      (existed ? replaced : created).push(fileName);
      continue;
    }
    if (existed) {
      preserved.push(fileName);
      continue;
    }
    if (publishExclusively(targetPath, templates[fileName], fileMode)) created.push(fileName);
    else preserved.push(fileName);
  }

  return { directory, created, preserved, replaced };
}

/**
 * Fills missing global seed files.
 *
 * Existing files are left alone so that re-running init never discards
 * hand-edited config; pass `force` to overwrite them from the template.
 */
export function initializeGlobalDoomConfig(
  homeDirectory = os.homedir(),
  options: GlobalDoomInitOptions = {},
): GlobalDoomInitResult {
  return initializeDoomConfig(
    globalDoomConfigDirectory(homeDirectory),
    DOOM_CONFIG_TEMPLATES,
    options,
    PRIVATE_DIRECTORY_MODE,
    PRIVATE_FILE_MODE,
  );
}

/** Seeds repository-local configuration without creating or changing Pi settings. */
export function initializeRepositoryDoomConfig(
  repositoryRoot = process.cwd(),
  options: RepositoryDoomInitOptions = {},
): RepositoryDoomInitResult {
  return initializeDoomConfig(
    path.join(path.resolve(repositoryRoot), DOOM_DIRECTORY),
    REPOSITORY_DOOM_CONFIG_TEMPLATES,
    options,
    REPOSITORY_DIRECTORY_MODE,
    REPOSITORY_FILE_MODE,
  );
}
