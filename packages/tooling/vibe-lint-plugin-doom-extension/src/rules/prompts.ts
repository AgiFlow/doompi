import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';

const PACKAGE_MANIFEST_NAME = 'package.json';
const PROMPTS_DIRECTORY = path.join('src', 'prompts');
const PROMPTS_PUBLISH_PATH = 'src/prompts';
const SKILL_MANIFEST_NAME = 'SKILL.md';
const KEBAB_CASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const MARKDOWN_LINK = /\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\s*\)/gu;

interface PromptPackageManifest {
  files?: unknown;
}

interface PromptFrontmatter {
  description?: string;
  name?: string;
}

function readManifest(filePath: string): PromptPackageManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PromptPackageManifest;
  } catch {
    return null;
  }
}

function scalarValue(source: string): string {
  const value = source.trim();
  if (value.length < 2) return value;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function frontmatterFields(source: string): PromptFrontmatter | null {
  const match = FRONTMATTER.exec(source);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/u);
  const fields: PromptFrontmatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(description|name):(?:[ \t]*(.*))?$/u.exec(lines[index]);
    if (!field) continue;
    let value = field[2]?.trim() ?? '';
    if (value === '|' || value === '>') {
      const continuation: string[] = [];
      while (index + 1 < lines.length && /^\s+/u.test(lines[index + 1])) {
        index += 1;
        continuation.push(lines[index].trim());
      }
      value = continuation.join(value === '>' ? ' ' : '\n');
    }
    fields[field[1] as keyof PromptFrontmatter] = scalarValue(value);
  }
  return fields;
}

function skillManifestPaths(directory: string): string[] {
  const manifests: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === SKILL_MANIFEST_NAME) manifests.push(target);
    }
  };
  visit(directory);
  return manifests.sort();
}

function llmsPromptTargets(source: string): Set<string> {
  const targets = new Set<string>();
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    const target = match[1].split('#', 1)[0].replace(/^\.\//u, '');
    targets.add(target);
  }
  return targets;
}

function promptViolations(configRoot: string, manifest: PromptPackageManifest): string[] {
  const promptsRoot = path.join(configRoot, PROMPTS_DIRECTORY);
  if (!fs.existsSync(promptsRoot)) return [];
  if (!fs.statSync(promptsRoot).isDirectory()) return [`${PROMPTS_PUBLISH_PATH} must be a directory`];

  const problems: string[] = [];
  if (!Array.isArray(manifest.files) || !manifest.files.includes(PROMPTS_PUBLISH_PATH)) {
    problems.push(`package.json files must contain exact entry "${PROMPTS_PUBLISH_PATH}"`);
  }

  const llmsPath = path.join(configRoot, 'llms.txt');
  const llmsTargets = fs.existsSync(llmsPath)
    ? llmsPromptTargets(fs.readFileSync(llmsPath, 'utf8'))
    : new Set<string>();
  if (!fs.existsSync(llmsPath)) problems.push('llms.txt is required when src/prompts exists');

  for (const entry of fs
    .readdirSync(promptsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const promptRelative = `${PROMPTS_PUBLISH_PATH}/${entry.name}`;
    if (!entry.isDirectory()) {
      problems.push(`unexpected direct file ${promptRelative}`);
      continue;
    }
    if (!KEBAB_CASE_NAME.test(entry.name)) problems.push(`prompt directory must be kebab-case: ${promptRelative}`);

    const promptDirectory = path.join(promptsRoot, entry.name);
    const skillPath = path.join(promptDirectory, SKILL_MANIFEST_NAME);
    const manifests = skillManifestPaths(promptDirectory);
    if (manifests.length !== 1 || manifests[0] !== skillPath) {
      problems.push(`${promptRelative} must contain exactly one direct SKILL.md`);
    } else {
      const frontmatter = frontmatterFields(fs.readFileSync(skillPath, 'utf8'));
      if (!frontmatter) {
        problems.push(`${promptRelative}/SKILL.md must start with YAML frontmatter`);
      } else {
        if (frontmatter.name !== entry.name) {
          problems.push(`${promptRelative}/SKILL.md frontmatter name must equal ${entry.name}`);
        }
        if (!frontmatter.description?.trim()) {
          problems.push(`${promptRelative}/SKILL.md frontmatter description must be nonempty`);
        }
      }
    }

    const skillTarget = `${promptRelative}/${SKILL_MANIFEST_NAME}`;
    if (!llmsTargets.has(skillTarget)) problems.push(`llms.txt must link ${skillTarget}`);
  }
  return problems;
}

export const doomPromptShape: RuleDefinition = {
  preflight: true,
  rule: 'Package-owned Doom Help prompts use a published, indexed src/prompts skill layout',
  rationale:
    'A single source-owned prompt layout keeps Help discovery complete and ensures every shipped descriptor can read its exact package resources.',
  check(filePath, configRoot) {
    if (path.resolve(filePath) !== path.join(path.resolve(configRoot), PACKAGE_MANIFEST_NAME)) return null;
    const manifest = readManifest(filePath);
    if (!manifest) return null;
    const problems = promptViolations(configRoot, manifest);
    return problems.length > 0 ? `Invalid Doom prompt resources: ${problems.join('; ')}` : null;
  },
};
