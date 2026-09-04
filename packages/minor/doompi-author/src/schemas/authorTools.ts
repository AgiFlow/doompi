import {
  AuthorDescribeToolsInputSchema,
  AuthorUseToolsInputSchema,
  type AuthorUseToolsInput,
} from '@agimon-ai/doompi-extension-contracts/author-facade';

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

export function parseDescribeAuthorToolsInput(value: unknown): Record<string, never> {
  const input = decoded(value);
  if (!isRecord(input) || Object.keys(input).length !== 0) throw new Error('describe_author_tools accepts no input.');
  return {};
}

export function parseUseAuthorToolInput(value: unknown): AuthorUseToolsInput {
  const input = decoded(value);
  if (!isRecord(input) || Object.keys(input).some((key) => !['catalogToken', 'name', 'arguments'].includes(key))) {
    throw new Error('use_author_tools input is invalid.');
  }
  if (typeof input.catalogToken !== 'string' || input.catalogToken.length === 0 || input.catalogToken.length > 256) {
    throw new Error('A bounded catalogToken is required.');
  }
  if (typeof input.name !== 'string' || input.name.length > 30 || !/^[a-z][a-z0-9_]*$/u.test(input.name)) {
    throw new Error('A valid Author capability name is required.');
  }
  if (!isRecord(input.arguments)) throw new Error('Author capability arguments must be an object.');
  return { catalogToken: input.catalogToken, name: input.name, arguments: input.arguments };
}
