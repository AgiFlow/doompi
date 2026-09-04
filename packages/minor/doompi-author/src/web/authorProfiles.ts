import type { AuthorJsonSchema } from '../types/author.ts';
import type { AuthorDocumentKind, AuthorTrustedProfile } from './authorViewportTypes.ts';
import {
  addAuthorAnnotation,
  authorDocument,
  reviseAuthorDocument,
  reviseAuthorFragment,
  setAuthorCrop,
} from './authorWorkspaceStore.ts';
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
      name: 'author_replace_text',
      label: 'Replace text',
      description: 'Replace the local draft of one open Author text document.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'path', 'content'],
        properties: { ...TARGET_PROPERTIES, content: { type: 'string' } },
      },
      execute: async (input) => {
        const { sessionId, path, value } = target(input);
        if (authorDocument(sessionId, path) === undefined) throw new Error('Author document is not open');
        reviseAuthorDocument(sessionId, path, text(value.content, 'content'));
        return { revision: authorDocument(sessionId, path)?.revisions.at(-1)?.revision ?? 0 };
      },
    },
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
  tools: [
    {
      name: 'author_set_crop',
      label: 'Set crop',
      description: 'Set the local crop rectangle for one open Author image.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'path', 'x', 'y', 'width', 'height'],
        properties: {
          ...TARGET_PROPERTIES,
          x: { type: 'number', minimum: 0 },
          y: { type: 'number', minimum: 0 },
          width: { type: 'number', exclusiveMinimum: 0 },
          height: { type: 'number', exclusiveMinimum: 0 },
        },
      },
      execute: async (input) => {
        const { sessionId, path, value } = target(input);
        const values = [value.x, value.y, value.width, value.height];
        if (!values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
          throw new Error('Crop values must be finite numbers');
        }
        const [x, y, width, height] = values as number[];
        if (x! < 0 || y! < 0 || width! <= 0 || height! <= 0) throw new Error('Invalid crop rectangle');
        setAuthorCrop(sessionId, path, { x: x!, y: y!, width: width!, height: height! });
        return { updated: true };
      },
    },
  ],
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

function structuredProfile(sessionId: string, path: string): AuthorTrustedProfile {
  return {
    id: AUTHOR_RUNTIME_BINDING_IDS.text,
    tools: [
      {
        name: 'author_replace_fragment',
        label: 'Replace fragment',
        description: 'Replace one editable fragment in the focused structured document draft.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['fragmentId', 'replacement'],
          properties: { fragmentId: { type: 'string' }, replacement: { type: 'string' } },
        },
        execute: async (input) => {
          const value = record(input);
          const fragmentId = text(value.fragmentId, 'fragmentId');
          const replacement = text(value.replacement, 'replacement');
          const document = authorDocument(sessionId, path);
          const fragment = document?.fragments?.find((candidate) => candidate.id === fragmentId);
          if (fragment === undefined || fragment.readOnly === true) throw new Error('Author fragment is not editable');
          reviseAuthorFragment(sessionId, path, fragmentId, replacement);
          return { updated: true };
        },
      },
    ],
  };
}

export function authorProfilesForDocument(
  sessionId: string,
  path: string,
  kind: AuthorDocumentKind,
): readonly AuthorTrustedProfile[] {
  if (kind === 'image') return [bindProfile(AUTHOR_MEDIA_PROFILE, sessionId, path)];
  if (kind === 'text' || kind === 'markdown') return [bindProfile(AUTHOR_TEXT_PROFILE, sessionId, path)];
  if (kind === 'slides' || kind === 'csv' || kind === 'pptx' || kind === 'xlsx')
    return [structuredProfile(sessionId, path)];
  return [];
}
