import type { AuthorJsonSchema } from '../types/author.ts';
import type { AuthorDocumentKind, AuthorTrustedProfile } from './authorViewportTypes.ts';
import { authorGridTools } from './authorGridTools.ts';
import { addAuthorAnnotation } from './authorWorkspaceStore.ts';
import { AUTHOR_RUNTIME_BINDING_IDS } from './AuthorRuntime.ts';

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected an object');
  return input as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function target(input: unknown): { sessionId: string; path: string; value: Record<string, unknown> } {
  const value = record(input);
  return { sessionId: text(value.sessionId, 'sessionId'), path: text(value.path, 'path'), value };
}

const TARGET_PROPERTIES = {
  sessionId: { type: 'string', minLength: 1 },
  path: { type: 'string', minLength: 1 },
} as const;

export const AUTHOR_TEXT_PROFILE: AuthorTrustedProfile = {
  id: AUTHOR_RUNTIME_BINDING_IDS.text,
  tools: [
    {
      name: 'author_add_comment',
      label: 'Add comment',
      description: 'Add a local review comment to one open Author document.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'path', 'body'],
        properties: { ...TARGET_PROPERTIES, body: { type: 'string' }, quote: { type: 'string' } },
      },
      execute: async (input) => {
        const { sessionId, path, value } = target(input);
        const body = text(value.body, 'body');
        addAuthorAnnotation(sessionId, path, {
          id: `${Date.now()}:${body.length}`,
          kind: 'comment',
          body,
          ...(typeof value.quote === 'string' ? { quote: value.quote } : {}),
        });
        return { added: true };
      },
    },
    {
      name: 'author_add_highlight',
      label: 'Add highlight',
      description: 'Highlight a line range in one open Author text document.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'path', 'startLine', 'endLine'],
        properties: {
          ...TARGET_PROPERTIES,
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
      },
      execute: async (input) => {
        const { sessionId, path, value } = target(input);
        if (!Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine)) {
          throw new Error('Highlight lines must be integers');
        }
        const startLine = value.startLine as number;
        const endLine = value.endLine as number;
        if (startLine < 1 || endLine < startLine) throw new Error('Invalid highlight range');
        addAuthorAnnotation(sessionId, path, {
          id: `${Date.now()}:${startLine}:${endLine}`,
          kind: 'highlight',
          body: '',
          startLine,
          endLine,
        });
        return { added: true };
      },
    },
  ],
};

export const AUTHOR_MEDIA_PROFILE: AuthorTrustedProfile = {
  id: AUTHOR_RUNTIME_BINDING_IDS.media,
  tools: [],
};

export const AUTHOR_TRUSTED_PROFILES = [AUTHOR_TEXT_PROFILE, AUTHOR_MEDIA_PROFILE] as const;

function bindProfile(profile: AuthorTrustedProfile, sessionId: string, path: string): AuthorTrustedProfile {
  return {
    id: profile.id,
    tools: profile.tools.map((tool) => {
      const schema = tool.inputSchema as Record<string, unknown>;
      const properties = record(schema.properties);
      const { sessionId: _sessionId, path: _path, ...boundProperties } = properties;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((entry) => entry !== 'sessionId' && entry !== 'path')
        : [];
      return {
        ...tool,
        inputSchema: { ...schema, properties: boundProperties, required } as AuthorJsonSchema,
        execute: async (input: unknown, signal: AbortSignal) =>
          await tool.execute({ ...record(input), sessionId, path }, signal),
      };
    }),
  };
}

export function authorProfilesForDocument(
  sessionId: string,
  path: string,
  kind: AuthorDocumentKind,
): readonly AuthorTrustedProfile[] {
  const profiles =
    kind === 'image'
      ? [bindProfile(AUTHOR_MEDIA_PROFILE, sessionId, path)]
      : kind === 'text' || kind === 'markdown'
        ? [bindProfile(AUTHOR_TEXT_PROFILE, sessionId, path)]
        : [];
  const tools = authorGridTools(sessionId, path, kind);
  if (tools.length === 0) return profiles;
  return profiles.length === 0
    ? [{ id: AUTHOR_RUNTIME_BINDING_IDS.media, tools }]
    : [{ ...profiles[0]!, tools: [...profiles[0]!.tools, ...tools] }];
}
