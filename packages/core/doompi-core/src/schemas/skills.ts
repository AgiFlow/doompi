import type { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

/** Provider-owned Cordis service for live skill-directory contributions. */
export const DOOM_SKILL_SOURCES_SERVICE = 'doom/skill-sources';

/**
 * The custom session entry journaled once Pi has rebuilt its resource catalog
 * for a reload.
 *
 * A reload is the only thing that changes which skills exist, and Pi publishes
 * nothing for it: the whole wire record of a `/domains` switch is the single
 * `response:prompt` for the command that triggered it. An RPC client therefore
 * has no way to learn that the `get_commands` answer it cached, which is what
 * the web cockpit completes `$` from, now describes the previous domains.
 *
 * This entry is that missing signal. It rides Pi's `entry_appended` frames the
 * way the minor-mode catalog projection does, so it needs no new protocol, and
 * a custom entry with no registered renderer is invisible in the TUI.
 */
export const DOOM_RESOURCE_CATALOG_ENTRY_TYPE = 'doom-resource-catalog';

/**
 * The payload of a resource-catalog entry.
 *
 * Arrival is the signal; a client re-reads the catalog rather than diffing
 * this. The revision only distinguishes one rebuild from the next in a journal
 * a human is reading.
 */
export interface ResourceCatalogProjection {
  readonly version: 1;
  readonly revision: number;
}

const MAX_GENERATION_LENGTH = 256;

export const SkillSourceNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$',
});

export const SkillSourceContributionSchema = Type.Object(
  {
    source: SkillSourceNameSchema,
    /** Absolute directories, the same ones the source hands `resources_discover`. */
    directories: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export interface SkillSourceContribution {
  readonly source: string;
  readonly directories: readonly string[];
}

export interface SkillSourceContributionHandle {
  readonly source: string;
  readonly generation: string;
  dispose(): void;
}

/** Direct registrar/query/subscription seam owned by doompi-skill. */
export interface DoomSkillSourcesService {
  readonly generation: string;
  register(contribution: SkillSourceContribution): SkillSourceContributionHandle;
  list(): readonly SkillSourceContribution[];
  subscribe(listener: (contributions: readonly SkillSourceContribution[]) => void): () => void;
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/skill-sources': DoomSkillSourcesService;
  }
}

interface RegisteredSkillSource {
  readonly token: symbol;
  readonly contribution: SkillSourceContribution;
}

function cloneContribution(contribution: SkillSourceContribution): SkillSourceContribution {
  return { source: contribution.source, directories: [...contribution.directories] };
}

function validateContribution(contribution: SkillSourceContribution): SkillSourceContribution {
  if (Check(SkillSourceContributionSchema, contribution)) return cloneContribution(contribution);
  const [first] = Errors(SkillSourceContributionSchema, contribution);
  throw new TypeError(
    `Invalid Doom skill-source contribution${first ? ` at ${first.instancePath || '/'}: ${first.message}` : ''}.`,
  );
}

/** Creates the provider-owned skill-source registry for one Cordis session. */
export function createDoomSkillSourcesService(generation: string): DoomSkillSourcesService {
  if (generation.length === 0 || generation.length > MAX_GENERATION_LENGTH) {
    throw new TypeError('Doom skill sources require a valid generation.');
  }

  const registrations = new Map<string, RegisteredSkillSource>();
  const listeners = new Set<(contributions: readonly SkillSourceContribution[]) => void>();
  let sequence = 0;
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) throw new Error('The Doom skill-sources service is disposed.');
  };
  const list = (): readonly SkillSourceContribution[] =>
    [...registrations.values()]
      .map(({ contribution }) => cloneContribution(contribution))
      .sort((left, right) => left.source.localeCompare(right.source));
  const notify = (): void => {
    const contributions = list();
    for (const listener of listeners) listener(contributions);
  };

  const service: DoomSkillSourcesService = {
    generation,
    register(contribution) {
      ensureActive();
      const validated = validateContribution(contribution);
      sequence += 1;
      const token = Symbol(validated.source);
      const registrationGeneration = `${generation}:skill-source:${sequence}`;
      registrations.set(validated.source, { token, contribution: validated });
      notify();
      let registrationDisposed = false;
      return Object.freeze({
        source: validated.source,
        generation: registrationGeneration,
        dispose() {
          if (registrationDisposed) return;
          registrationDisposed = true;
          if (registrations.get(validated.source)?.token !== token) return;
          registrations.delete(validated.source);
          notify();
        },
      });
    },
    list,
    subscribe(listener) {
      ensureActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registrations.clear();
      listeners.clear();
    },
  };
  return Object.freeze(service);
}

export function readDoomSkillSourcesService(context: Context): DoomSkillSourcesService | undefined {
  return context.get(DOOM_SKILL_SOURCES_SERVICE) as DoomSkillSourcesService | undefined;
}

export function requireDoomSkillSourcesService(context: Context): DoomSkillSourcesService {
  const service = readDoomSkillSourcesService(context);
  if (!service) throw new Error('Doom skill sources are unavailable. Load @agimon-ai/doompi-skill.');
  return service;
}
