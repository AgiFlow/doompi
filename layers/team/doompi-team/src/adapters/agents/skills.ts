/**
 * Resolving skill files by name and rendering them into a child system prompt.
 *
 * A skill is a markdown file, either `<dir>/SKILL.md` or a bare `<name>.md`,
 * found by sweeping a fixed list of search roots. The same name can appear in
 * several roots, so the sweep records where each hit came from and the highest
 * priority source wins.
 *
 * WHY THIS IS A SERVICE AND NOT A MODULE OF FUNCTIONS:
 * Resolution walks every skill root and reads the frontmatter of every markdown
 * file it finds. Prompt assembly asks for the catalogue on each launch and
 * completion asks on each keystroke, so the answers have to be cached, and a
 * cache needs an owner that can be invalidated and swapped in a test.
 *
 * DESIGN PATTERNS:
 * - Two caches with different lifetimes. Listing answers "does this name exist
 *   and where", reading answers "what does it say"; the first goes stale on any
 *   directory change, the second only when one file's mtime moves
 * - Both are bounded LRUs. The predecessor held the listing in a single mutable
 *   slot keyed by cwd, which thrashed the moment two working directories were in
 *   play, and evicted parsed files in insertion order regardless of use
 * - Every filesystem call is best-effort. A skill root that cannot be read is
 *   skipped, never fatal: a missing skill surfaces to the caller as `missing`
 * - Symlinked and repeated directories are visited at most once per priority, so
 *   a cycle in the skill tree terminates
 *
 * AVOID:
 * - Walking the skill roots on a completion path without going through the cache
 * - Deriving a config directory here instead of asking `configDir.ts`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXTRA_SKILL_DIRS_ENV } from '../../types/environment';
import { getAgentDir, getProjectConfigDir } from '../filesystem/configDir';
import { LruCache } from '../../services/support/lruCache';
import { canonicalizeDiscoveryCwd } from './projectRoot';

/**
 * Where a skill file was found.
 *
 * Deliberately not `AgentSource`: a skill can also come from a settings list or
 * from an extension directory, neither of which can hold an agent definition.
 */
export type SkillSource =
  | 'project'
  | 'user'
  | 'project-settings'
  | 'user-settings'
  | 'extension'
  | 'builtin'
  | 'unknown';

export interface ResolvedSkill {
  name: string;
  path: string;
  content: string;
  description?: string;
  source: SkillSource;
}

export interface SkillLocation {
  path: string;
  source: SkillSource;
}

export interface SkillResolution {
  resolved: ResolvedSkill[];
  missing: string[];
}

export interface DiscoveredSkill {
  name: string;
  source: SkillSource;
  description?: string;
}

/**
 * Discovery and reading of skill files.
 *
 * Behind an interface for the same reason agent discovery is: the results are
 * cached and invalidated, and callers on the completion path must be able to ask
 * repeatedly without paying for a directory walk each time.
 */
export type SkillDiscoveryContract = {
  /** Locate one skill by name, or undefined when no root holds it. */
  resolveSkillPath(skillName: string, cwd: string): SkillLocation | undefined;
  /** Read the named skills, reporting any that could not be resolved. */
  resolveSkills(skillNames: string[], cwd: string, localSkillPaths?: string[], localBaseDir?: string): SkillResolution;
  /** Resolve against `primaryCwd`, retrying whatever is missing in `fallbackCwd`. */
  resolveSkillsWithFallback(
    skillNames: string[],
    primaryCwd: string,
    fallbackCwd?: string,
    localSkillPaths?: string[],
    localBaseDir?: string,
  ): SkillResolution;
  /** Every skill visible from `cwd`, sorted by name. */
  discoverAvailableSkills(cwd: string): DiscoveredSkill[];
  /** Drop cached results. Call after writing or removing a skill file. */
  invalidate(): void;
};

/** One entry in a listing sweep: located, but not yet read. */
interface CachedSkillEntry {
  name: string;
  filePath: string;
  source: SkillSource;
  description?: string;
  /** Discovery order, used to break ties between equal-priority sources. */
  order: number;
}

interface SkillFileCacheEntry {
  mtimeMs: number;
  skill: ResolvedSkill;
}

interface SkillListingCacheEntry {
  skills: CachedSkillEntry[];
  expiresAt: number;
}

interface SkillSearchPath {
  path: string;
  source: SkillSource;
}

/** Roughly the number of distinct skills one session touches. */
const SKILL_FILE_CACHE_CAPACITY = 50;
/** One entry per (cwd, agentDir) pair; a session rarely spans more than a few. */
const SKILL_LISTING_CACHE_CAPACITY = 8;
/**
 * How long a listing stays valid.
 *
 * Short enough that a skill added mid-session appears without a restart, long
 * enough that a burst of completions does not re-walk the roots per keystroke.
 */
const SKILL_LISTING_TTL_MS = 5_000;

/** Cache keys join two paths, so use a separator that cannot occur in either. */
const CACHE_KEY_SEPARATOR = '\0';

/**
 * The orchestration skill, excluded from every listing and injection.
 *
 * A subagent already has the orchestration tools wired in, so handing it the
 * skill that explains how to reach for them wastes context and invites a child
 * to fan out again. The name is the published skill's, not this package's.
 */
const SUBAGENT_ORCHESTRATION_SKILL = 'pi-subagents';

const SKILL_FILE_NAME = 'SKILL.md';
const MARKDOWN_EXTENSION = '.md';
const FRONTMATTER_FENCE = '---';
const NODE_MODULES_DIR = 'node_modules';
const HOME_ALIAS_PREFIX = '~/';

/** Sources a listing can report, most authoritative first. */
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  project: 700,
  'project-settings': 650,
  user: 300,
  'user-settings': 250,
  extension: 150,
  builtin: 100,
  unknown: 0,
};

function priorityOf(source: SkillSource): number {
  return SOURCE_PRIORITY[source] ?? SOURCE_PRIORITY.unknown;
}

/** Index of the first character after a closing frontmatter fence, or -1. */
function findFrontmatterEnd(normalized: string): number {
  if (!normalized.startsWith(FRONTMATTER_FENCE)) return -1;
  return normalized.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
}

export function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const endIndex = findFrontmatterEnd(normalized);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 1 + FRONTMATTER_FENCE.length).trim();
}

export function parseSkillDescription(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  const endIndex = findFrontmatterEnd(normalized);
  if (endIndex === -1) return undefined;

  const frontmatter = normalized.slice(FRONTMATTER_FENCE.length, endIndex).trim();
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
}

function maybeReadSkillDescription(filePath: string): string | undefined {
  try {
    return parseSkillDescription(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // The description is optional metadata; an unreadable file still lists by name.
    return undefined;
  }
}

function isWithinPath(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Read a JSON file that is allowed to be absent, but not allowed to be corrupt. */
function readOptionalJsonFile(filePath: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} '${filePath}': ${message}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/** Extract the string entries of a settings file's `skills` array. */
function readSettingsSkillList(settings: unknown): string[] {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return [];
  const skills = (settings as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((entry): entry is string => typeof entry === 'string');
}

function collectSettingsSkillPaths(cwd: string, agentDir: string): SkillSearchPath[] {
  const results: SkillSearchPath[] = [];
  const projectConfigDir = getProjectConfigDir(cwd);
  const settingsFiles = [
    { file: path.join(projectConfigDir, 'settings.json'), base: projectConfigDir, source: 'project-settings' as const },
    { file: path.join(agentDir, 'settings.json'), base: agentDir, source: 'user-settings' as const },
  ];

  for (const { file, base, source } of settingsFiles) {
    for (const entry of readSettingsSkillList(readOptionalJsonFile(file, 'skills settings file'))) {
      let resolved = entry;
      if (resolved.startsWith(HOME_ALIAS_PREFIX)) {
        resolved = path.join(os.homedir(), resolved.slice(HOME_ALIAS_PREFIX.length));
      } else if (!path.isAbsolute(resolved)) {
        resolved = path.resolve(base, resolved);
      }
      results.push({ path: resolved, source });
    }
  }

  return results;
}

function extraSkillPaths(): SkillSearchPath[] {
  return (process.env[EXTRA_SKILL_DIRS_ENV] ?? '')
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => ({ path: directory, source: 'extension' as const }));
}

function buildSkillPaths(cwd: string, agentDir: string): SkillSearchPath[] {
  const projectConfigDir = getProjectConfigDir(cwd);
  return [
    ...extraSkillPaths(),
    { path: path.join(projectConfigDir, 'skills'), source: 'project' },
    { path: path.join(cwd, '.agents', 'skills'), source: 'project' },
    { path: path.join(agentDir, 'skills'), source: 'user' },
    { path: path.join(os.homedir(), '.agents', 'skills'), source: 'user' },
    ...collectSettingsSkillPaths(cwd, agentDir),
  ];
}

/** Classify a hit that arrived without a source hint, by which root contains it. */
function inferSkillSource(filePath: string, cwd: string, agentDir: string, sourceHint?: SkillSource): SkillSource {
  if (sourceHint) return sourceHint;

  const projectConfigRoot = path.resolve(getProjectConfigDir(cwd));
  const projectSkillsRoot = path.resolve(projectConfigRoot, 'skills');
  const projectAgentsRoot = path.resolve(cwd, '.agents');
  const userSkillsRoot = path.resolve(agentDir, 'skills');
  const userAgentRoot = path.resolve(agentDir);
  const userAgentsRoot = path.resolve(os.homedir(), '.agents');

  if (isWithinPath(filePath, projectSkillsRoot) || isWithinPath(filePath, projectAgentsRoot)) return 'project';
  if (isWithinPath(filePath, projectConfigRoot)) return 'project-settings';

  if (isWithinPath(filePath, userSkillsRoot) || isWithinPath(filePath, userAgentsRoot)) return 'user';
  if (isWithinPath(filePath, userAgentRoot)) return 'user-settings';

  return 'unknown';
}

function chooseHigherPrioritySkill(
  existing: CachedSkillEntry | undefined,
  candidate: CachedSkillEntry,
): CachedSkillEntry {
  if (!existing) return candidate;
  const existingPriority = priorityOf(existing.source);
  const candidatePriority = priorityOf(candidate.source);
  if (candidatePriority > existingPriority) return candidate;
  if (candidatePriority < existingPriority) return existing;
  return candidate.order < existing.order ? candidate : existing;
}

function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

/** Directory names never worth descending into while hunting for skills. */
function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || name === NODE_MODULES_DIR;
}

function statOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    // A dangling symlink or a path removed mid-sweep is simply not a skill.
    return undefined;
  }
}

function readDirOrEmpty(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    // An unreadable root must not abort the sweep over the remaining roots.
    return [];
  }
}

/**
 * Sweep the given roots for skill files.
 *
 * Pure with respect to the caches, which is what lets it serve both the cached
 * catalogue and an agent's own uncached `skillPath` list.
 */
function collectFilesystemSkills(cwd: string, agentDir: string, skillPaths: SkillSearchPath[]): CachedSkillEntry[] {
  const entries: CachedSkillEntry[] = [];
  const seen = new Map<string, number>();
  const visitedDirectories = new Map<string, number>();
  let order = 0;

  const pushEntry = (name: string, filePath: string, sourceHint?: SkillSource) => {
    const resolvedFile = path.resolve(filePath);
    if (!fs.existsSync(resolvedFile)) return;
    const source = inferSkillSource(resolvedFile, cwd, agentDir, sourceHint);
    const existingIndex = seen.get(resolvedFile);
    if (existingIndex !== undefined) {
      const existing = entries[existingIndex];
      if (existing && priorityOf(source) > priorityOf(existing.source)) {
        entries[existingIndex] = {
          ...existing,
          name,
          source,
          description: maybeReadSkillDescription(resolvedFile),
        };
      }
      return;
    }
    seen.set(resolvedFile, entries.length);
    entries.push({
      name,
      filePath: resolvedFile,
      source,
      description: maybeReadSkillDescription(resolvedFile),
      order: order++,
    });
  };

  /** False when this directory was already walked at an equal or better priority. */
  const markDirectoryVisited = (dirPath: string, sourceHint?: SkillSource): boolean => {
    let resolvedDir: string;
    try {
      resolvedDir = fs.realpathSync(dirPath);
    } catch {
      // Symlink resolution is only needed to detect cycles; the lexical path is
      // a sound fallback that at worst walks one directory twice.
      resolvedDir = path.resolve(dirPath);
    }
    const priority = sourceHint ? priorityOf(sourceHint) : SOURCE_PRIORITY.unknown;
    const previousPriority = visitedDirectories.get(resolvedDir);
    if (previousPriority !== undefined && previousPriority >= priority) return false;
    visitedDirectories.set(resolvedDir, priority);
    return true;
  };

  const walkSkillDirectories = (dirPath: string, sourceHint?: SkillSource) => {
    if (!markDirectoryVisited(dirPath, sourceHint)) return;

    // A directory holding SKILL.md is itself the skill; do not descend further.
    const skillFile = path.join(dirPath, SKILL_FILE_NAME);
    if (fs.existsSync(skillFile)) {
      pushEntry(path.basename(dirPath), skillFile, sourceHint);
      return;
    }

    for (const entry of readDirOrEmpty(dirPath)) {
      if (shouldSkipDirectory(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const entryPath = path.join(dirPath, entry.name);
      if (statOrUndefined(entryPath)?.isDirectory()) walkSkillDirectories(entryPath, sourceHint);
    }
  };

  for (const skillPath of skillPaths) {
    if (!fs.existsSync(skillPath.path)) continue;

    const stat = statOrUndefined(skillPath.path);
    if (!stat) continue;

    // A root may point straight at a markdown file rather than a directory.
    if (stat.isFile()) {
      const fileName = path.basename(skillPath.path);
      if (!isMarkdownFile(fileName)) continue;
      const skillName =
        fileName.toLowerCase() === SKILL_FILE_NAME.toLowerCase()
          ? path.basename(path.dirname(skillPath.path))
          : path.basename(fileName, path.extname(fileName));
      pushEntry(skillName, skillPath.path, skillPath.source);
      continue;
    }

    if (!stat.isDirectory()) continue;

    const rootSkillFile = path.join(skillPath.path, SKILL_FILE_NAME);
    if (fs.existsSync(rootSkillFile)) {
      pushEntry(path.basename(skillPath.path), rootSkillFile, skillPath.source);
      continue;
    }

    markDirectoryVisited(skillPath.path, skillPath.source);

    for (const child of readDirOrEmpty(skillPath.path)) {
      if (child.name.startsWith('.')) continue;
      const childPath = path.join(skillPath.path, child.name);
      if (child.isDirectory() || child.isSymbolicLink()) {
        if (shouldSkipDirectory(child.name)) continue;
        if (statOrUndefined(childPath)?.isDirectory()) walkSkillDirectories(childPath, skillPath.source);
        continue;
      }
      if (child.isFile() && isMarkdownFile(child.name)) {
        pushEntry(path.basename(child.name, path.extname(child.name)), childPath, skillPath.source);
      }
    }
  }

  return entries;
}

export class SkillDiscoveryService implements SkillDiscoveryContract {
  /** Parsed skill bodies, keyed by resolved file path and validated by mtime. */
  private readonly fileCache = new LruCache<string, SkillFileCacheEntry>(SKILL_FILE_CACHE_CAPACITY);
  /** Located-but-unread catalogues, keyed by the (cwd, agentDir) pair. */
  private readonly listingCache = new LruCache<string, SkillListingCacheEntry>(SKILL_LISTING_CACHE_CAPACITY);

  /**
   * Seams for tests, as protected members rather than constructor arguments.
   *
   * Runtime tuning is not part of this service's dependency contract. A test
   * subclass overrides these values without abstracting the clock.
   */
  protected readonly listingTtlMs: number = SKILL_LISTING_TTL_MS;

  protected now(): number {
    return Date.now();
  }

  resolveSkillPath(skillName: string, cwd: string): SkillLocation | undefined {
    const skill = this.listSkills(cwd).find((candidate) => candidate.name === skillName);
    if (!skill) return undefined;
    return { path: skill.filePath, source: skill.source };
  }

  resolveSkills(skillNames: string[], cwd: string, localSkillPaths?: string[], localBaseDir?: string): SkillResolution {
    const resolved: ResolvedSkill[] = [];
    const missing: string[] = [];
    const localByName = localSkillPaths?.length
      ? collectLocalSkills(cwd, localSkillPaths, localBaseDir)
      : new Map<string, CachedSkillEntry>();

    for (const name of skillNames) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      if (trimmed === SUBAGENT_ORCHESTRATION_SKILL) {
        missing.push(trimmed);
        continue;
      }

      // An agent's own skillPath outranks anything found in the shared roots.
      const local = localByName.get(trimmed);
      let skill = local ? this.readSkill(trimmed, local.filePath, local.source) : undefined;
      if (!skill) {
        const location = this.resolveSkillPath(trimmed, cwd);
        if (location) skill = this.readSkill(trimmed, location.path, location.source);
      }
      if (skill) resolved.push(skill);
      else missing.push(trimmed);
    }

    return { resolved, missing };
  }

  /**
   * Resolve against `primaryCwd`, then retry whatever is still missing elsewhere.
   *
   * A child launched into a worktree still needs the skills configured in the
   * repository it was launched from.
   */
  resolveSkillsWithFallback(
    skillNames: string[],
    primaryCwd: string,
    fallbackCwd?: string,
    localSkillPaths?: string[],
    localBaseDir?: string,
  ): SkillResolution {
    const resolvedPrimaryCwd = path.resolve(primaryCwd);
    const primary = this.resolveSkills(skillNames, resolvedPrimaryCwd, localSkillPaths, localBaseDir);
    if (!fallbackCwd || primary.missing.length === 0) return primary;
    const resolvedFallbackCwd = path.resolve(fallbackCwd);
    if (canonicalizeDiscoveryCwd(resolvedPrimaryCwd) === canonicalizeDiscoveryCwd(resolvedFallbackCwd)) return primary;

    const fallback = this.resolveSkills(primary.missing, resolvedFallbackCwd);
    return {
      resolved: [...primary.resolved, ...fallback.resolved],
      missing: fallback.missing,
    };
  }

  discoverAvailableSkills(cwd: string): DiscoveredSkill[] {
    return this.listSkills(cwd)
      .filter((skill) => skill.name !== SUBAGENT_ORCHESTRATION_SKILL)
      .map((skill) => ({
        name: skill.name,
        source: skill.source,
        description: skill.description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  invalidate(): void {
    this.fileCache.clear();
    this.listingCache.clear();
  }

  /** The catalogue visible from `cwd`, sweeping the roots only when stale. */
  private listSkills(cwd: string): CachedSkillEntry[] {
    const timestamp = this.now();
    const resolvedCwd = path.resolve(cwd);
    const resolvedAgentDir = path.resolve(getAgentDir());
    const key = `${canonicalizeDiscoveryCwd(resolvedCwd)}${CACHE_KEY_SEPARATOR}${canonicalizeDiscoveryCwd(resolvedAgentDir)}`;

    const cached = this.listingCache.get(key);
    if (cached && cached.expiresAt > timestamp) return cached.skills;

    const loaded = collectFilesystemSkills(
      resolvedCwd,
      resolvedAgentDir,
      buildSkillPaths(resolvedCwd, resolvedAgentDir),
    );
    const dedupedByName = new Map<string, CachedSkillEntry>();
    for (const entry of loaded) {
      dedupedByName.set(entry.name, chooseHigherPrioritySkill(dedupedByName.get(entry.name), entry));
    }

    const skills = [...dedupedByName.values()].sort((a, b) => a.order - b.order);
    this.listingCache.set(key, { skills, expiresAt: timestamp + this.listingTtlMs });
    return skills;
  }

  /** Read one skill file, reusing the cached parse while its mtime holds. */
  private readSkill(skillName: string, skillPath: string, source: SkillSource): ResolvedSkill | undefined {
    try {
      const stat = fs.statSync(skillPath);
      const cached = this.fileCache.get(skillPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.skill;

      const raw = fs.readFileSync(skillPath, 'utf-8');
      const skill: ResolvedSkill = {
        name: skillName,
        path: skillPath,
        content: stripSkillFrontmatter(raw),
        description: parseSkillDescription(raw),
        source,
      };

      this.fileCache.set(skillPath, { mtimeMs: stat.mtimeMs, skill });
      return skill;
    } catch {
      // Treat an unreadable skill file as unresolved so the caller reports it
      // missing rather than injecting a half-formed block into a child prompt.
      return undefined;
    }
  }
}

/**
 * Index skill files supplied by an agent's own `skillPath`, keyed by name.
 *
 * Deliberately uncached: these paths are per-agent rather than per-directory, so
 * they would pollute a catalogue cache keyed on cwd.
 */
function collectLocalSkills(
  cwd: string,
  localSkillPaths: string[],
  localBaseDir?: string,
): Map<string, CachedSkillEntry> {
  const localByName = new Map<string, CachedSkillEntry>();
  const localEntries = collectFilesystemSkills(
    cwd,
    getAgentDir(),
    localSkillPaths.map((entry) => ({
      path: path.resolve(localBaseDir ?? cwd, entry),
      source: 'unknown' as const,
    })),
  );
  for (const entry of localEntries) {
    if (!localByName.has(entry.name)) localByName.set(entry.name, entry);
  }
  return localByName;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the skill catalogue for a child system prompt.
 *
 * Only names, descriptions and locations are injected. The child reads a skill
 * when its description matches the task, which keeps the prompt small no matter
 * how large the configured skill bodies are.
 */
export function buildSkillInjection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';

  const lines = [
    'The following configured skills are available to this subagent.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  const stableSkills = [...skills].sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
  for (const skill of stableSkills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXmlText(skill.name)}</name>`);
    lines.push(`    <description>${escapeXmlText(skill.description ?? '')}</description>`);
    lines.push(`    <location>${escapeXmlText(skill.path)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function dedupeSkillNames(names: string[]): string[] {
  return [...new Set(names.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/**
 * Normalise the `skills` tool parameter into a name list.
 *
 * `false` means "no skills at all" and `undefined` means "use the agent's own
 * configuration", which is why they are distinct return values rather than both
 * collapsing to an empty array.
 */
export function normalizeSkillInput(input: string | string[] | boolean | undefined): string[] | false | undefined {
  if (input === false) return false;
  if (input === true || input === undefined) return undefined;
  if (Array.isArray(input)) return dedupeSkillNames(input);

  // Models sometimes serialise the parameter as a JSON string instead of a native
  // array. Splitting '["a","b"]' on commas would embed brackets and quotes into
  // the names, and resolution would then fail with no obvious cause.
  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return dedupeSkillNames(parsed.filter((entry): entry is string => typeof entry === 'string'));
      }
    } catch {
      // Not valid JSON after all; fall through to the comma-separated reading.
    }
  }
  return dedupeSkillNames(input.split(','));
}
