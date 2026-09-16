/** The npm name this package registers its voice tools and contributions under. */
export const DOMAIN_SOURCE = '@agimon-ai/doompi-domain';

/**
 * The only names a domain, an operation or a handoff token may carry.
 *
 * Selections arrive from the model and from the command line, and every one of
 * them ends up in a filesystem path or a process environment variable, so the
 * shape is constrained once here and reused by the schema and the validator.
 */
export const SAFE_DOMAIN_NAME = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/u;

/**
 * The selection as the command, the picker and the voice tool all need to see it.
 *
 * `active` is what the session persisted and `effective` is what it is running
 * with, which differ while a major mode contributes its default domains.
 */
export interface DomainListing {
  readonly active: string[];
  readonly effective: string[];
  readonly available: string[];
}

/** One comma-triggered autocomplete response for the `/domains` argument. */
export interface DomainCompletion {
  readonly prefix: string;
  readonly items: Array<{ value: string; label: string }>;
}
