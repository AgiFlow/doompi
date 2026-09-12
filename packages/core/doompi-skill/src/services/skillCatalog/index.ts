import fs from 'node:fs';
import path from 'node:path';
import { listDomainNames, type PluginSkillDiscovery, resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import type { SkillSourceContribution } from '@agimon-ai/doompi-extension-contracts/skills';
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import { materializePluginEntries } from '@agimon-ai/doompi-domain/plugins';

const SKILLS_DIRECTORY = 'skills';
const SHARED_SKILLS_OWNER = '.claude/skills';

export type SkillGroupKey = 'extensions' | 'help' | 'plugins' | 'default';

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  group: SkillGroupKey;
  /** Package name for an extension, plugin directory name, or `.claude/skills`. */
  owner: string;
  modelInvocable: boolean;
  /**
   * What removing this skill would save from the `<available_skills>` block.
   *
   * Marginal rather than proportional: the block has fixed framing that no
   * single skill pays for, so the useful figure is what actually goes away.
   * Bodies are excluded because they load on demand and are not a resting cost.
   */
  promptTokens?: number;
}

export interface SkillOwnerNode {
  owner: string;
  skills: SkillEntry[];
}

export interface SkillGroup {
  key: SkillGroupKey;
  label: string;
  owners: SkillOwnerNode[];
}

export interface SkillCatalog {
  groups: SkillGroup[];
  skillCount: number;
  /** Tokens the `<available_skills>` prompt block costs on every request. */
  promptTokens: number;
  /** Tokens every loaded SKILL.md costs in full, if all of them were read. */
  bodyTokens: number;
  /** Frontmatter and read failures, surfaced instead of thrown. */
  diagnostics: string[];
}

export interface SkillCatalogOptions {
  repoRoot: string;
  /** Exact files the current selection resolved to, from `HarnessState.skillDirectories`. */
  activeSkillDirectories: readonly string[];
  extensionSources: readonly SkillSourceContribution[];
  /** Activation-gated wrappers already accepted by the merged active-skill view. */
  helpSkills?: readonly Skill[];
  /** Bounded Help activation and collision diagnostics. */
  helpDiagnostics?: readonly string[];
}

/**
 * The tokenizer, loaded on first use rather than at import.
 *
 * `gpt-tokenizer` carries its whole vocabulary and costs about a tenth of a
 * second to load. This module is reachable from the skills extension, which Pi
 * loads at session start, so a top-level import would charge every session for
 * a surface most of them never open.
 */
let tokenizer: Promise<typeof import('gpt-tokenizer')> | undefined;

export async function counter(): Promise<(text: string) => number> {
  tokenizer ??= import('gpt-tokenizer');
  return (await tokenizer).countTokens;
}

/**
 * Matches a directory against the active set.
 *
 * A domain that lists a plugin subset puts individual skill directories in the
 * set rather than the plugin's `skills` root, so containment has to be checked
 * both ways: the set may hold an ancestor of the directory, or a descendant of
 * it.
 */
function createActiveMatcher(directories: readonly string[]): (directory: string) => boolean {
  const active = directories.map((directory) => path.resolve(directory));
  return (directory) => {
    const resolved = path.resolve(directory);
    return active.some(
      (entry) =>
        entry === resolved || entry.startsWith(`${resolved}${path.sep}`) || resolved.startsWith(`${entry}${path.sep}`),
    );
  };
}

function collect(
  directory: string,
  group: SkillGroupKey,
  owner: string,
  isActive: (directory: string) => boolean,
  loaded: Skill[],
  diagnostics: string[],
  discovery: PluginSkillDiscovery = 'recursive',
): SkillEntry[] {
  const result = loadSkillsFromDir({ dir: directory, source: owner });
  for (const diagnostic of result.diagnostics) {
    diagnostics.push(`${diagnostic.path ?? directory}: ${diagnostic.message}`);
  }
  // Checked per skill, not per root: a subset domain selects some of a plugin's
  // skills and leaves the rest on disk, unloaded and therefore not listed.
  const root = path.resolve(directory);
  const kept = result.skills.filter((skill) => {
    const skillDirectory = path.dirname(skill.filePath);
    if (discovery === 'direct-children' && path.dirname(skillDirectory) !== root) return false;
    return isActive(skillDirectory);
  });
  // Kept in their loaded form as well, because the prompt-block cost is measured
  // by handing them back to Pi's own formatter.
  loaded.push(...kept);
  return kept
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      group,
      owner,
      modelInvocable: !skill.disableModelInvocation,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sortOwners(owners: SkillOwnerNode[]): SkillOwnerNode[] {
  return owners.sort((left, right) => left.owner.localeCompare(right.owner));
}

function collectHelpSkills(skills: readonly Skill[], loaded: Skill[], diagnostics: string[]): SkillOwnerNode[] {
  const occupiedNames = new Set(loaded.map((skill) => skill.name));
  const owners = new Map<string, SkillEntry[]>();
  const candidates = [...skills].sort(
    (left, right) =>
      left.sourceInfo.source.localeCompare(right.sourceInfo.source) ||
      left.name.localeCompare(right.name) ||
      left.filePath.localeCompare(right.filePath),
  );
  for (const skill of candidates) {
    if (occupiedNames.has(skill.name)) {
      diagnostics.push(
        `Help ${skill.sourceInfo.source} [HELP_SKILL_COLLISION]: '${skill.name}' was ignored because a normal skill wins.`,
      );
      continue;
    }
    occupiedNames.add(skill.name);
    loaded.push(skill);
    const owner = skill.sourceInfo.source;
    const entries = owners.get(owner) ?? [];
    entries.push({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      group: 'help',
      owner,
      modelInvocable: !skill.disableModelInvocation,
    });
    owners.set(owner, entries);
  }
  return sortOwners(
    [...owners.entries()].map(([owner, entries]) => ({
      owner,
      skills: entries.sort((left, right) => left.name.localeCompare(right.name)),
    })),
  );
}

/**
 * Every skill this session actually loaded, grouped by where it comes from,
 * priced in tokens.
 *
 * Discovery runs over `loadSkillsFromDir` from Pi rather than the harness's own
 * walker so the listing matches what Pi would load, including its ignore-file
 * handling; the same skills are then handed to Pi's `formatSkillsForPrompt` so
 * the always-on figure is the real prompt block rather than a reconstruction of
 * it.
 */
export async function buildSkillCatalog(options: SkillCatalogOptions): Promise<SkillCatalog> {
  const { repoRoot } = options;
  const isActive = createActiveMatcher(options.activeSkillDirectories);
  const diagnostics: string[] = [...(options.helpDiagnostics ?? [])];
  const loaded: Skill[] = [];

  const extensionOwners: SkillOwnerNode[] = [];
  for (const entry of options.extensionSources) {
    const skills = entry.directories.flatMap((directory) =>
      collect(directory, 'extensions', entry.source, () => true, loaded, diagnostics),
    );
    if (skills.length > 0) extensionOwners.push({ owner: entry.source, skills });
  }

  const pluginOwners: SkillOwnerNode[] = [];
  const domainPlugins = await materializePluginEntries(resolvePluginEntries(repoRoot, listDomainNames(repoRoot), []));
  for (const entry of domainPlugins) {
    const directory = path.join(entry.directory, SKILLS_DIRECTORY);
    if (!fs.existsSync(directory)) continue;
    const owner = path.basename(entry.directory);
    const skills = collect(directory, 'plugins', owner, isActive, loaded, diagnostics, entry.skillDiscovery);
    if (skills.length > 0) pluginOwners.push({ owner, skills });
  }

  const sharedDirectory = path.join(repoRoot, '.claude', SKILLS_DIRECTORY);
  const sharedSkills = collect(sharedDirectory, 'default', SHARED_SKILLS_OWNER, isActive, loaded, diagnostics);
  const defaultOwners = sharedSkills.length > 0 ? [{ owner: SHARED_SKILLS_OWNER, skills: sharedSkills }] : [];
  const helpOwners = collectHelpSkills(options.helpSkills ?? [], loaded, diagnostics);

  const groups: SkillGroup[] = [
    { key: 'extensions', label: 'extensions', owners: sortOwners(extensionOwners) },
    { key: 'help', label: 'Help', owners: helpOwners },
    { key: 'plugins', label: 'plugins', owners: sortOwners(pluginOwners) },
    { key: 'default', label: 'default', owners: defaultOwners },
  ];

  const countTokens = await counter();
  const prompt = formatSkillsForPrompt(loaded);
  const framingTokens = countTokens(formatSkillsForPrompt([]));
  const marginal = new Map<string, number>();
  for (const skill of loaded) {
    marginal.set(skill.name, Math.max(0, countTokens(formatSkillsForPrompt([skill])) - framingTokens));
  }
  for (const group of groups) {
    for (const owner of group.owners) {
      for (const skill of owner.skills) {
        const tokens = marginal.get(skill.name);
        if (tokens !== undefined) skill.promptTokens = tokens;
      }
    }
  }
  let bodyTokens = 0;
  for (const skill of loaded) {
    try {
      bodyTokens += countTokens(fs.readFileSync(skill.filePath, 'utf8'));
    } catch (error) {
      diagnostics.push(`${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    groups,
    skillCount: loaded.length,
    promptTokens: prompt ? countTokens(prompt) : 0,
    bodyTokens,
    diagnostics,
  };
}

/** The skills a name resolves to, used to decide what `enter` can invoke. */
export function findSkill(catalog: SkillCatalog, name: string): SkillEntry | undefined {
  for (const group of catalog.groups) {
    for (const owner of group.owners) {
      const match = owner.skills.find((skill) => skill.name === name);
      if (match) return match;
    }
  }
  return undefined;
}
