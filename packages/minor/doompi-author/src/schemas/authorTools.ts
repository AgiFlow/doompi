import { AuthorDescribeToolsInputSchema, AuthorUseToolsInputSchema, type AuthorUseToolsInput } from './authorFacade';

export const AUTHOR_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function validAlias(value: unknown): value is string {
  return typeof value === 'string' && AUTHOR_ALIAS_PATTERN.test(value);
}

export const OpenAuthoringFileInputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    alias: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_-]{0,63}$' },
  },
  required: ['path'],
  additionalProperties: false,
} as const;
export const DescribeAuthorToolsInputSchema = AuthorDescribeToolsInputSchema;
export const UseAuthorToolInputSchema = AuthorUseToolsInputSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Author tool input must be valid JSON.');
  }
}

export function parseOpenAuthoringFileInput(value: unknown): { path: string; alias?: string } {
  const input = decoded(value);
  if (!isRecord(input) || Object.keys(input).some((key) => key !== 'path' && key !== 'alias')) {
    throw new Error('open_authoring_file input is invalid.');
  }
  if (
    typeof input.path !== 'string' ||
    input.path.length === 0 ||
    input.path.length > 4096 ||
    input.path.includes('\0')
  ) {
    throw new Error('A bounded relative document path is required.');
  }
  if (input.alias !== undefined && !validAlias(input.alias))
    throw new Error('A bounded Author canvas alias is required.');
  return { path: input.path, ...(input.alias === undefined ? {} : { alias: input.alias }) };
}
export function parseDescribeAuthorToolsInput(value: unknown): { alias?: string } {
  const input = decoded(value);
  if (!isRecord(input) || Object.keys(input).some((key) => key !== 'alias'))
    throw new Error('describe_author_tools accepts only an optional alias.');
  if (input.alias !== undefined && !validAlias(input.alias))
    throw new Error('A bounded Author canvas alias is required.');
  return input.alias === undefined ? {} : { alias: input.alias };
}

export function parseUseAuthorToolInput(value: unknown): AuthorUseToolsInput {
  const input = decoded(value);
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !['alias', 'catalogToken', 'name', 'arguments'].includes(key))
  ) {
    throw new Error('use_author_tools input is invalid.');
  }
  if (typeof input.catalogToken !== 'string' || input.catalogToken.length === 0 || input.catalogToken.length > 256) {
    throw new Error('A bounded catalogToken is required.');
  }
  if (typeof input.name !== 'string' || input.name.length > 30 || !/^[a-z][a-z0-9_]*$/u.test(input.name)) {
    throw new Error('A valid Author capability name is required.');
  }
  if (!isRecord(input.arguments)) throw new Error('Author capability arguments must be an object.');
  if (input.alias !== undefined && !validAlias(input.alias))
    throw new Error('A bounded Author canvas alias is required.');
  return {
    ...(input.alias === undefined ? {} : { alias: input.alias }),
    catalogToken: input.catalogToken,
    name: input.name,
    arguments: input.arguments,
  };
}
