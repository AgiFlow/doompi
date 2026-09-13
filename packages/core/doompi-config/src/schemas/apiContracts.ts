import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const Text = Type.String();
const Optional = Type.Optional;
const Strings = Type.Array(Text);
const NullableText = Type.Union([Text, Type.Null()]);
const Scope = Type.Union([Type.Literal('global'), Type.Literal('repository')]);
const Origin = Type.Union([Type.Literal('global'), Type.Literal('repository'), Type.Literal('default')]);
export const SettingsConfigSchema = Type.Object({
  repoRoot: Text,
  hashes: Type.Object({ global: Text, repository: Text }),
  values: Type.Record(
    Text,
    Type.Object({
      value: Optional(Text),
      origin: Origin,
      scope: Type.Union([Scope, Type.Literal('both')]),
    }),
  ),
});
const SettingsEditSchema = Type.Object({ keyPath: Strings, value: Type.Union([Text, Type.Number(), Type.Null()]) });
export const SettingsWriteSchema = Type.Union([
  Type.Object({ repoRoot: Text, scope: Scope, ...SettingsEditSchema.properties, expectedHash: Text }),
  Type.Object({
    repoRoot: Text,
    scope: Scope,
    edits: Type.Array(SettingsEditSchema, { minItems: 1, maxItems: 100 }),
    expectedHash: Text,
  }),
]);

const Repository = Type.Object({ id: Text, name: Text, path: Text, active: Type.Boolean() });
const Catalog = Type.Array(
  Type.Object({ name: Text, description: Optional(Text), expandsTo: Optional(Strings), layers: Optional(Strings) }),
);
const SelectionText = Type.Object({ effective: Optional(Text), repository: Optional(Text), origin: Origin });
const SelectionStrings = Type.Object({ effective: Optional(Strings), repository: Optional(Strings), origin: Origin });
export const RepositorySettingsSchema = Type.Object({
  repository: Repository,
  hash: Text,
  catalogs: Type.Object({ majorModes: Catalog, domains: Catalog, profiles: Catalog }),
  selection: Type.Object({ majorMode: SelectionText, domains: SelectionStrings, profile: SelectionText }),
});
export const RepositorySelectionWriteSchema = Type.Object({
  repositoryId: Text,
  expectedHash: Text,
  changes: Type.Object({
    majorMode: Optional(NullableText),
    domains: Optional(Type.Union([Strings, Type.Null()])),
    profile: Optional(NullableText),
  }),
});
const Images = Type.Object({
  autoResize: Type.Boolean(),
  maxDimension: Type.Number(),
  minDimension: Type.Number(),
  maxAllowedDimension: Type.Number(),
});
const http: DoomHttpContract[] = (['global', 'workspace'] as const).flatMap((scope) => {
  const common = { scope, basePath: 'config', authentication: 'owner' as const };
  return [
    {
      ...common,
      id: 'config',
      path: '/config',
      method: 'GET',
      description: 'Read selected settings keys and file hashes.',
      parameters: [{ name: 'key', in: 'query', required: false, schema: Strings }],
      responses: jsonApiResponses(SettingsConfigSchema),
    },
    {
      ...common,
      id: 'value',
      path: '/value',
      method: 'PUT',
      description: 'Write a setting with an optimistic file hash.',
      body: { contentType: 'application/json', required: true, schema: SettingsWriteSchema },
      responses: jsonApiResponses(SettingsConfigSchema),
    },
    {
      ...common,
      id: 'repositories',
      path: '/repositories',
      method: 'GET',
      description: 'List admitted repositories.',
      responses: jsonApiResponses(Type.Object({ repositories: Type.Array(Repository) })),
    },
    {
      ...common,
      id: 'repository',
      path: '/repository',
      method: 'GET',
      description: 'Read the mounted workspace catalog and selection.',
      availability: 'Requires a workspace mount; global returns 404.',
      responses: jsonApiResponses(RepositorySettingsSchema),
    },
    {
      ...common,
      id: 'selection',
      path: '/repository/selection',
      method: 'PUT',
      description: 'Update the mounted workspace selection.',
      availability: 'Requires a workspace mount; global returns 404.',
      body: { contentType: 'application/json', required: true, schema: RepositorySelectionWriteSchema },
      responses: jsonApiResponses(RepositorySettingsSchema),
    },
    ...(scope === 'global'
      ? [
          {
            ...common,
            id: 'images.get',
            path: '/images',
            method: 'GET' as const,
            description: 'Read image resizing limits.',
            responses: jsonApiResponses(Images),
          },
          {
            ...common,
            id: 'images.put',
            path: '/images',
            method: 'PUT' as const,
            description: 'Update image resizing settings; dimensions are clamped.',
            body: {
              contentType: 'application/json',
              required: true,
              schema: Type.Object({ autoResize: Optional(Type.Boolean()), maxDimension: Optional(Type.Number()) }),
            },
            responses: jsonApiResponses(Images),
          },
        ]
      : []),
  ] satisfies DoomHttpContract[];
});
export const apiContracts = defineApiContract({ version: 1, http, sockets: [], dynamic: [] });
export default apiContracts;
