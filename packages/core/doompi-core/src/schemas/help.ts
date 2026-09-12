import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Provider-owned Cordis service for the live Help catalog. */
export const DOOM_HELP_SERVICE = 'doom/help';
export const DOOM_HELP_MAX_CONTRIBUTORS = 32;
export const DOOM_HELP_MAX_SKILLS = 64;
export const DOOM_HELP_MAX_DIAGNOSTICS = 64;
export const DOOM_HELP_MAX_DESCRIPTION_LENGTH = 512;
export const DOOM_HELP_MAX_DIAGNOSTIC_LENGTH = 512;

const MAX_SOURCE_LENGTH = 128;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_MODULE_URL_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 256;

export const DOOM_HELP_ERROR_CODE = {
  contributorLimit: 'HELP_CONTRIBUTOR_LIMIT',
  disposed: 'HELP_DISPOSED',
  duplicateSkill: 'HELP_DUPLICATE_SKILL',
  inactiveSnapshot: 'HELP_INACTIVE_SNAPSHOT',
  invalidContribution: 'HELP_INVALID_CONTRIBUTION',
  invalidGeneration: 'HELP_INVALID_GENERATION',
  invalidSnapshot: 'HELP_INVALID_SNAPSHOT',
} as const;

export type DoomHelpErrorCode = (typeof DOOM_HELP_ERROR_CODE)[keyof typeof DOOM_HELP_ERROR_CODE];

export class DoomHelpError extends Error {
  readonly code: DoomHelpErrorCode;

  constructor(code: DoomHelpErrorCode, message: string) {
    super(message);
    this.name = 'DoomHelpError';
    this.code = code;
  }
}

export const DoomHelpSourceSchema = Type.String({
  minLength: 1,
  maxLength: MAX_SOURCE_LENGTH,
  pattern: '^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$',
});

export const DoomHelpSkillNameSchema = Type.String({
  minLength: 1,
  maxLength: MAX_SKILL_NAME_LENGTH,
  pattern: '^[a-z0-9][a-z0-9-]*$',
});

export const DoomHelpSkillDescriptorSchema = Type.Object(
  {
    name: DoomHelpSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: DOOM_HELP_MAX_DESCRIPTION_LENGTH }),
  },
  { additionalProperties: false },
);
export type DoomHelpSkillDescriptor = Static<typeof DoomHelpSkillDescriptorSchema>;

export const DoomHelpContributionSchema = Type.Object(
  {
    source: DoomHelpSourceSchema,
    moduleUrl: Type.String({ minLength: 1, maxLength: MAX_MODULE_URL_LENGTH }),
    skills: Type.Array(DoomHelpSkillDescriptorSchema, { minItems: 1, maxItems: DOOM_HELP_MAX_SKILLS }),
  },
  { additionalProperties: false },
);
export type DoomHelpContribution = Static<typeof DoomHelpContributionSchema>;

const GenerationSchema = Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH });

export const DoomHelpActivationSchema = Type.Union([
  Type.Literal('inactive'),
  Type.Literal('activating'),
  Type.Literal('active'),
  Type.Literal('degraded'),
]);
export type DoomHelpActivation = Static<typeof DoomHelpActivationSchema>;

export const DoomHelpSkillSchema = Type.Object(
  {
    source: DoomHelpSourceSchema,
    name: DoomHelpSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: DOOM_HELP_MAX_DESCRIPTION_LENGTH }),
    filePath: Type.String({ minLength: 1, maxLength: MAX_MODULE_URL_LENGTH }),
    baseDir: Type.String({ minLength: 1, maxLength: MAX_MODULE_URL_LENGTH }),
  },
  { additionalProperties: false },
);
export type DoomHelpSkill = Static<typeof DoomHelpSkillSchema>;

export const DoomHelpDiagnosticSchema = Type.Object(
  {
    source: Type.Optional(DoomHelpSourceSchema),
    code: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Z0-9_]+$' }),
    message: Type.String({ minLength: 1, maxLength: DOOM_HELP_MAX_DIAGNOSTIC_LENGTH }),
  },
  { additionalProperties: false },
);
export type DoomHelpDiagnostic = Static<typeof DoomHelpDiagnosticSchema>;

export const DoomHelpSnapshotSchema = Type.Object(
  {
    hostGeneration: GenerationSchema,
    revision: Type.Integer({ minimum: 0 }),
    activation: DoomHelpActivationSchema,
    skills: Type.Array(DoomHelpSkillSchema, { maxItems: DOOM_HELP_MAX_SKILLS }),
    diagnostics: Type.Array(DoomHelpDiagnosticSchema, { maxItems: DOOM_HELP_MAX_DIAGNOSTICS }),
  },
  { additionalProperties: false },
);
export type DoomHelpSnapshot = Static<typeof DoomHelpSnapshotSchema>;

export interface DoomHelpSnapshotDraft {
  readonly activation: DoomHelpActivation;
  readonly skills: readonly DoomHelpSkill[];
  readonly diagnostics: readonly DoomHelpDiagnostic[];
}

export interface DoomHelpContributionHandle {
  readonly source: string;
  readonly generation: string;
  dispose(): void;
}

/** Direct, session-local registrar and query surface owned by doompi-help. */
export interface DoomHelpService {
  readonly generation: string;
  register(contribution: DoomHelpContribution): DoomHelpContributionHandle;
  listContributions(): readonly DoomHelpContribution[];
  subscribeContributions(listener: (contributions: readonly DoomHelpContribution[]) => void): () => void;
  getSnapshot(): DoomHelpSnapshot;
  publish(snapshot: DoomHelpSnapshotDraft): DoomHelpSnapshot;
  subscribeSnapshot(listener: (snapshot: DoomHelpSnapshot) => void): () => void;
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/help': DoomHelpService;
  }
}

interface RegisteredContribution {
  readonly token: symbol;
  readonly generation: string;
  readonly contribution: DoomHelpContribution;
}

function schemaFailure(
  schema: typeof DoomHelpContributionSchema | typeof DoomHelpSnapshotSchema,
  value: unknown,
): string {
  const [first] = Errors(schema, value);
  return first ? ` at ${first.instancePath || '/'}: ${first.message}` : '';
}

function cloneContribution(contribution: DoomHelpContribution): DoomHelpContribution {
  return {
    source: contribution.source,
    moduleUrl: contribution.moduleUrl,
    skills: contribution.skills.map((skill) => ({ ...skill })),
  };
}

function cloneSnapshot(snapshot: DoomHelpSnapshot): DoomHelpSnapshot {
  return {
    ...snapshot,
    skills: snapshot.skills.map((skill) => ({ ...skill })),
    diagnostics: snapshot.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function validateContribution(contribution: DoomHelpContribution): DoomHelpContribution {
  if (!Check(DoomHelpContributionSchema, contribution)) {
    throw new DoomHelpError(
      DOOM_HELP_ERROR_CODE.invalidContribution,
      `Invalid Help contribution${schemaFailure(DoomHelpContributionSchema, contribution)}.`,
    );
  }
  const names = new Set<string>();
  for (const skill of contribution.skills) {
    if (names.has(skill.name)) {
      throw new DoomHelpError(
        DOOM_HELP_ERROR_CODE.duplicateSkill,
        `Help contribution '${contribution.source}' declares duplicate skill '${skill.name}'.`,
      );
    }
    names.add(skill.name);
  }
  return cloneContribution(contribution);
}

/** Creates the provider-owned Help service value for one Cordis session. */
export function createDoomHelpService(generation: string): DoomHelpService {
  if (!Check(GenerationSchema, generation)) {
    throw new DoomHelpError(DOOM_HELP_ERROR_CODE.invalidGeneration, 'Doom Help requires a valid generation.');
  }

  const contributions = new Map<string, RegisteredContribution>();
  const contributionListeners = new Set<(value: readonly DoomHelpContribution[]) => void>();
  const snapshotListeners = new Set<(value: DoomHelpSnapshot) => void>();
  let registrationSequence = 0;
  let disposed = false;
  let snapshot: DoomHelpSnapshot = {
    hostGeneration: generation,
    revision: 0,
    activation: 'inactive',
    skills: [],
    diagnostics: [],
  };

  const ensureActive = (): void => {
    if (disposed) throw new DoomHelpError(DOOM_HELP_ERROR_CODE.disposed, 'The Doom Help service is disposed.');
  };
  const list = (): readonly DoomHelpContribution[] =>
    [...contributions.values()]
      .map(({ contribution }) => cloneContribution(contribution))
      .sort((left, right) => left.source.localeCompare(right.source));
  const notifyContributions = (): void => {
    const value = list();
    for (const listener of contributionListeners) listener(value);
  };

  const service: DoomHelpService = {
    generation,
    register(contribution) {
      ensureActive();
      const validated = validateContribution(contribution);
      if (!contributions.has(validated.source) && contributions.size >= DOOM_HELP_MAX_CONTRIBUTORS) {
        throw new DoomHelpError(
          DOOM_HELP_ERROR_CODE.contributorLimit,
          `Help accepts at most ${DOOM_HELP_MAX_CONTRIBUTORS} contributors.`,
        );
      }
      registrationSequence += 1;
      const token = Symbol(validated.source);
      const registrationGeneration = `${generation}:help:${registrationSequence}`;
      contributions.set(validated.source, {
        token,
        generation: registrationGeneration,
        contribution: validated,
      });
      notifyContributions();
      let registrationDisposed = false;
      return Object.freeze({
        source: validated.source,
        generation: registrationGeneration,
        dispose() {
          if (registrationDisposed) return;
          registrationDisposed = true;
          if (contributions.get(validated.source)?.token !== token) return;
          contributions.delete(validated.source);
          notifyContributions();
        },
      });
    },
    listContributions: list,
    subscribeContributions(listener) {
      ensureActive();
      contributionListeners.add(listener);
      return () => contributionListeners.delete(listener);
    },
    getSnapshot: () => cloneSnapshot(snapshot),
    publish(draft) {
      ensureActive();
      if (draft.activation === 'inactive' && draft.skills.length > 0) {
        throw new DoomHelpError(DOOM_HELP_ERROR_CODE.inactiveSnapshot, 'Inactive Help snapshots cannot expose skills.');
      }
      const next: DoomHelpSnapshot = {
        hostGeneration: generation,
        revision: snapshot.revision + 1,
        activation: draft.activation,
        skills: draft.skills.map((skill) => ({ ...skill })),
        diagnostics: draft.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      };
      if (!Check(DoomHelpSnapshotSchema, next)) {
        throw new DoomHelpError(
          DOOM_HELP_ERROR_CODE.invalidSnapshot,
          `Invalid Help snapshot${schemaFailure(DoomHelpSnapshotSchema, next)}.`,
        );
      }
      snapshot = next;
      const published = cloneSnapshot(snapshot);
      for (const listener of snapshotListeners) listener(cloneSnapshot(published));
      return published;
    },
    subscribeSnapshot(listener) {
      ensureActive();
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      contributions.clear();
      contributionListeners.clear();
      snapshotListeners.clear();
    },
  };
  return Object.freeze(service);
}

export function readDoomHelpService(context: Context): DoomHelpService | undefined {
  return context.get(DOOM_HELP_SERVICE) as DoomHelpService | undefined;
}

export function requireDoomHelpService(context: Context): DoomHelpService {
  const service = readDoomHelpService(context);
  if (!service) throw new Error('Doom Help is unavailable. Load @agimon-ai/doompi-help.');
  return service;
}
