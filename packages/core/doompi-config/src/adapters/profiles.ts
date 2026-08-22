import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDoomConfigSources } from './layeredConfig.ts';

/** Files that make up one repository persona, concatenated in this order. */
export const PERSONA_FILES = ['profile.md', 'SOUL.md', 'AGENTS.md'];

export interface AgentProfile {
  name: string;
  /** Directory relative to personaRoot, which remains the persona source. */
  persona: string;
  /**
   * Root the persona path resolves against: the repository root for a
   * repository profile, the global `.doom` directory for a global one.
   */
  personaRoot: string;
  /** Environment defaults. Values already exported by the caller win. */
  env: Record<string, string>;
}

interface ProfileConfigLayer {
  filePath: string;
  baseDirectory: string;
  roots: string[];
  entries: Record<string, unknown>;
}

const PROFILE_KEYS = new Set(['persona', 'env']);
const PROFILE_CATALOG_KEYS = new Set(['roots', 'entries']);
const PROFILES_FILE = 'profiles.yaml';
const PROFILES_ROOT_KEY = 'profiles';
const AGENTS_DIRECTORY = 'agents';
const PARENT_DIRECTORY = '..';
const TEXT_ENCODING = 'utf8';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== PARENT_DIRECTORY &&
      !relative.startsWith(`${PARENT_DIRECTORY}${path.sep}`))
  );
}

function parseEnvironment(name: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Profile "${name}" env must be a string mapping`);

  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`Profile "${name}" env.${key} must be a string`);
    environment[key] = entry;
  }
  return environment;
}

function parseProfileRoots(value: unknown, filePath: string, baseDirectory: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`profiles.roots in ${filePath} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`profiles.roots[${index}] in ${filePath} must be a non-empty string`);
    }
    return path.resolve(baseDirectory, entry.trim());
  });
}

function parseProfileLayer(source: { filePath: string; baseDirectory: string; document: unknown }): ProfileConfigLayer {
  if (!isRecord(source.document) || !isRecord(source.document[PROFILES_ROOT_KEY])) {
    throw new Error(`${source.filePath} must contain a profiles mapping`);
  }
  const unsupportedDocumentKeys = Object.keys(source.document).filter((key) => key !== PROFILES_ROOT_KEY);
  if (unsupportedDocumentKeys.length > 0) {
    throw new Error(`${source.filePath} may only contain profiles; unsupported: ${unsupportedDocumentKeys.join(', ')}`);
  }

  const profiles = source.document[PROFILES_ROOT_KEY];
  const usesCatalogShape = Object.hasOwn(profiles, 'roots') || Object.hasOwn(profiles, 'entries');
  if (!usesCatalogShape) {
    return { filePath: source.filePath, baseDirectory: source.baseDirectory, roots: [], entries: profiles };
  }

  const unsupportedCatalogKeys = Object.keys(profiles).filter((key) => !PROFILE_CATALOG_KEYS.has(key));
  if (unsupportedCatalogKeys.length > 0) {
    throw new Error(
      `profiles in ${source.filePath} may only contain roots and entries; unsupported: ${unsupportedCatalogKeys.join(', ')}`,
    );
  }
  if (profiles.entries !== undefined && !isRecord(profiles.entries)) {
    throw new Error(`profiles.entries in ${source.filePath} must be a mapping`);
  }
  return {
    filePath: source.filePath,
    baseDirectory: source.baseDirectory,
    roots: parseProfileRoots(profiles.roots, source.filePath, source.baseDirectory),
    entries: profiles.entries ?? {},
  };
}

function assertProfileInsideAllowedRoot(name: string, personaPath: string, lexicalRoots: readonly string[]): void {
  const realPersonaPath = fs.realpathSync(personaPath);
  if (!lexicalRoots.some((root) => isPathInside(fs.realpathSync(root), realPersonaPath))) {
    throw new Error(`Profile "${name}" persona must stay inside agents/ or a configured profile root`);
  }
}

function parseProfile(
  personaRoot: string,
  configuredRoots: readonly string[],
  name: string,
  value: unknown,
): AgentProfile {
  if (!isRecord(value)) throw new Error(`Profile "${name}" must be a mapping`);

  const unsupported = Object.keys(value).filter((key) => !PROFILE_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(`Profile "${name}" may only set persona and env; unsupported: ${unsupported.join(', ')}`);
  }
  if (typeof value.persona !== 'string' || value.persona.trim().length === 0) {
    throw new Error(`Profile "${name}" must set a persona`);
  }
  if (path.isAbsolute(value.persona)) {
    throw new Error(`Profile "${name}" persona must be relative to the config that declares it`);
  }

  const persona = value.persona;
  const personaPath = path.resolve(personaRoot, persona);
  const lexicalRoots = [path.resolve(personaRoot, AGENTS_DIRECTORY), ...configuredRoots].filter((root) =>
    isPathInside(root, personaPath),
  );
  if (lexicalRoots.length === 0) {
    throw new Error(`Profile "${name}" persona must stay inside agents/ or a configured profile root`);
  }
  if (!fs.existsSync(personaPath) || !fs.statSync(personaPath).isDirectory()) {
    throw new Error(`Profile "${name}" references a missing persona: ${persona}`);
  }
  assertProfileInsideAllowedRoot(name, personaPath, lexicalRoots);
  if (!buildPersonaPrompt(personaRoot, persona)) {
    throw new Error(`Profile "${name}" persona has no readable persona files: ${persona}`);
  }

  return { name, persona, personaRoot, env: parseEnvironment(name, value.env) };
}

function containsPersonaFile(directory: string): boolean {
  return PERSONA_FILES.some((file) => {
    try {
      return fs.lstatSync(path.join(directory, file)).isFile();
    } catch {
      return false;
    }
  });
}

function discoverProfile(directory: string, configuredRoot: string, personaRoot: string): AgentProfile | undefined {
  if (!containsPersonaFile(directory)) return undefined;
  try {
    const realConfiguredRoot = fs.realpathSync(configuredRoot);
    const realDirectory = fs.realpathSync(directory);
    if (!isPathInside(realConfiguredRoot, realDirectory)) return undefined;
    const persona = path.relative(personaRoot, directory) || '.';
    if (!buildPersonaPrompt(personaRoot, persona)) return undefined;
    return { name: path.basename(directory), persona, personaRoot, env: {} };
  } catch {
    // Automatic discovery ignores unreadable or unsafe candidates; explicit entries remain fatal.
    return undefined;
  }
}

function discoverProfileRoot(root: string, personaRoot: string): AgentProfile[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Configured profile root is not a directory: ${root}`);
  }

  const rootProfile = discoverProfile(root, root, personaRoot);
  if (rootProfile) return [rootProfile];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const profile = discoverProfile(path.join(root, entry.name), root, personaRoot);
      return profile ? [profile] : [];
    });
}

/**
 * Loads profiles from the global and repository configs, repository last.
 *
 * Configured roots accumulate and inspect themselves or their direct-child
 * directories for persona files. Later discoveries replace earlier names, and
 * explicit entries replace discoveries. Legacy flat profile mappings remain
 * accepted as explicit entries.
 */
export function loadProfiles(repoRoot: string, homeDirectory: string = os.homedir()): AgentProfile[] {
  const layers = readDoomConfigSources<unknown>(PROFILES_FILE, repoRoot, homeDirectory).map(parseProfileLayer);
  const byName = new Map<string, AgentProfile>();

  for (const layer of layers) {
    for (const root of layer.roots) {
      for (const profile of discoverProfileRoot(root, layer.baseDirectory)) byName.set(profile.name, profile);
    }
  }

  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer.entries)) {
      byName.set(name, parseProfile(layer.baseDirectory, layer.roots, name, value));
    }
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolves one selected profile and fails clearly when its name is unknown. */
export function resolveProfile(repoRoot: string, name: string, homeDirectory?: string): AgentProfile {
  const profile = loadProfiles(repoRoot, homeDirectory).find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  return profile;
}

export function listProfileNames(repoRoot: string, homeDirectory?: string): string[] {
  return loadProfiles(repoRoot, homeDirectory).map((profile) => profile.name);
}

/** Builds the persona system-prompt block, or undefined when nothing is readable. */
export function buildPersonaPrompt(personaRoot: string, personaDirectory: string): string | undefined {
  const sections: string[] = [];
  const personaPath = fs.realpathSync(path.join(personaRoot, personaDirectory));
  for (const file of PERSONA_FILES) {
    const filePath = path.join(personaPath, file);
    if (!fs.existsSync(filePath)) continue;
    const realFilePath = fs.realpathSync(filePath);
    const relativeFilePath = path.relative(personaPath, realFilePath);
    if (relativeFilePath === PARENT_DIRECTORY || relativeFilePath.startsWith(`${PARENT_DIRECTORY}${path.sep}`)) {
      throw new Error(`Persona file must stay inside ${personaDirectory}: ${file}`);
    }
    const content = fs.readFileSync(realFilePath, TEXT_ENCODING).trim();
    if (content) sections.push(content);
  }
  if (sections.length === 0) return undefined;
  return [`[PERSONA] You are operating as the person described below (source: ${personaDirectory}).`, ...sections].join(
    '\n\n',
  );
}

/** Applies profile environment defaults and returns only the values it contributed. */
export function applyProfileEnvironment(
  environment: NodeJS.ProcessEnv,
  defaults: Record<string, string>,
): Record<string, string> {
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (environment[key] !== undefined) continue;
    environment[key] = value;
    applied[key] = value;
  }
  return applied;
}

/** Replaces environment defaults previously contributed by another profile. */
export function replaceProfileEnvironment(
  environment: NodeJS.ProcessEnv,
  previous: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  for (const [key, value] of Object.entries(previous)) {
    if (environment[key] === value) delete environment[key];
  }
  return applyProfileEnvironment(environment, next);
}
