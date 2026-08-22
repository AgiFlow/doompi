import {
  DOOM_HELP_MAX_DIAGNOSTIC_LENGTH,
  DOOM_HELP_MAX_DIAGNOSTICS,
  type DoomHelpService,
  type DoomHelpSkill,
  type DoomHelpSnapshot,
} from '@agimon-ai/doompi-extension-contracts/help';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';

export interface SkillInventoryInput {
  normalSkills: readonly Skill[];
  deferredSkills: readonly Skill[];
  /** Names from Pi's command catalog when full normal Skill records are unavailable. */
  normalSkillNames?: readonly string[];
}

export interface MergedSkillInventory {
  /** Pi-native, unique deferred, then accepted Help skills in invocation-precedence order. */
  skills: readonly Skill[];
  /** Deferred and Help skills that are absent from Pi's existing prompt inventory. */
  additionalSkills: readonly Skill[];
  /** Accepted Help skills, retained separately for the Help catalog group. */
  helpSkills: readonly Skill[];
  diagnostics: readonly string[];
  diagnosticKey: string;
}

export interface ActiveHelpSkillView {
  bind(service: DoomHelpService): () => void;
  merge(input: SkillInventoryInput): MergedSkillInventory;
  dispose(): void;
}

function boundedDiagnostic(message: string): string {
  return message.slice(0, DOOM_HELP_MAX_DIAGNOSTIC_LENGTH);
}

function toSkill(skill: DoomHelpSkill): Skill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: skill.source,
      scope: 'temporary',
      origin: 'package',
      baseDir: skill.baseDir,
    }),
    disableModelInvocation: false,
  };
}

function activeHelpSkills(snapshot: DoomHelpSnapshot | undefined): DoomHelpSkill[] {
  if (!snapshot || snapshot.activation === 'inactive') return [];
  return [...snapshot.skills].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.name.localeCompare(right.name) ||
      left.filePath.localeCompare(right.filePath),
  );
}

function snapshotDiagnostics(snapshot: DoomHelpSnapshot | undefined): string[] {
  if (!snapshot) return [];
  return snapshot.diagnostics.map((entry) =>
    boundedDiagnostic(`Help ${entry.source ?? 'host'} [${entry.code}]: ${entry.message}`),
  );
}

export function mergeActiveHelpSkills(
  input: SkillInventoryInput,
  snapshot: DoomHelpSnapshot | undefined,
  clientDiagnostics: readonly string[] = [],
): MergedSkillInventory {
  const nativeNames = new Set([...input.normalSkills.map((skill) => skill.name), ...(input.normalSkillNames ?? [])]);
  const deferredSkills = input.deferredSkills.filter((skill) => !nativeNames.has(skill.name));
  const occupiedNames = new Set([...nativeNames, ...deferredSkills.map((skill) => skill.name)]);
  const helpSkills: Skill[] = [];
  const diagnostics = [...snapshotDiagnostics(snapshot), ...clientDiagnostics.map(boundedDiagnostic)];

  for (const candidate of activeHelpSkills(snapshot)) {
    if (occupiedNames.has(candidate.name)) {
      diagnostics.push(
        boundedDiagnostic(
          `Help ${candidate.source} [HELP_SKILL_COLLISION]: '${candidate.name}' was ignored because a normal skill wins.`,
        ),
      );
      continue;
    }
    occupiedNames.add(candidate.name);
    helpSkills.push(toSkill(candidate));
  }

  const boundedDiagnostics = diagnostics.slice(0, DOOM_HELP_MAX_DIAGNOSTICS);
  const additionalSkills = [...deferredSkills, ...helpSkills];
  return {
    skills: [...input.normalSkills, ...additionalSkills],
    additionalSkills,
    helpSkills,
    diagnostics: boundedDiagnostics,
    diagnosticKey: `${snapshot?.hostGeneration ?? 'absent'}:${snapshot?.revision ?? 0}:${boundedDiagnostics.join('\u0001')}`,
  };
}

export function createActiveHelpSkillView(): ActiveHelpSkillView {
  let binding: { readonly token: symbol; snapshot: DoomHelpSnapshot; unsubscribe(): void } | undefined;
  let disposed = false;
  return {
    bind(service) {
      if (disposed) throw new Error('The Help skill view is disposed.');
      const token = Symbol(service.generation);
      const current = binding;
      binding = undefined;
      current?.unsubscribe();
      const next: { readonly token: symbol; snapshot: DoomHelpSnapshot; unsubscribe(): void } = {
        token,
        snapshot: service.getSnapshot(),
        unsubscribe: service.subscribeSnapshot((snapshot) => {
          if (binding?.token === token) binding.snapshot = snapshot;
        }),
      };
      binding = next;
      let bindingDisposed = false;
      return () => {
        if (bindingDisposed) return;
        bindingDisposed = true;
        next.unsubscribe();
        if (binding?.token === token) binding = undefined;
      };
    },
    merge(input) {
      return mergeActiveHelpSkills(input, binding?.snapshot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = binding;
      binding = undefined;
      current?.unsubscribe();
    },
  };
}
