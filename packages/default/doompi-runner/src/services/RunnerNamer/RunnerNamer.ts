import type { IRunnerRegistry } from '../../types/runnerRegistry';
import type { IRunnerNamer } from './types.ts';

const MAX_SLUG_LENGTH = 32;
const MAX_ATTEMPTS = 1000;
const FALLBACK_SLUG = 'runner';
/** Shell noise that says nothing about what the command actually runs. */
const IGNORED_LEADING_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'exec']);

export class RunnerNamer implements IRunnerNamer {
  constructor(private readonly registry: IRunnerRegistry) {}

  async allocate(command: string, sessionId: string, requested?: string): Promise<string> {
    const base = slugify(requested ?? deriveSlug(command));
    const taken = new Set((await this.registry.listBySession(sessionId)).map((record) => record.name));
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < MAX_ATTEMPTS; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`Could not find a free runner name based on "${base}"`);
  }
}

/**
 * Names come from the first few meaningful words of the command, which is what
 * a reader recognises in a runner list: `nx-dev-start-api`, not `runner-3`.
 */
function deriveSlug(command: string): string {
  const words = command.split(/\s+/).filter((word) => word.length > 0 && !word.startsWith('-') && !word.includes('='));
  const meaningful = words.filter((word) => !IGNORED_LEADING_WORDS.has(word));
  return meaningful.slice(0, 4).join('-');
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : FALLBACK_SLUG;
}
