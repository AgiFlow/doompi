import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/apiContracts';
import { Type } from 'typebox';

const StringSchema = Type.String();
export const apiContracts = defineApiContract({
  version: 1,
  sockets: [],
  dynamic: [],
  http: [
    {
      id: 'style-system-preview.catalog',
      scope: 'session',
      basePath: 'style-system-preview',
      path: '/catalog',
      method: 'POST',
      authentication: 'owner',
      description: 'Discover style-system configurations and story metadata without rendering workspace components.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      },
      responses: jsonApiResponses(
        Type.Object({
          projects: Type.Array(
            Type.Object({
              appPath: StringSchema,
              configPath: StringSchema,
              preset: Type.Optional(StringSchema),
              bundler: Type.Optional(StringSchema),
              settings: Type.Record(Type.String(), Type.Unknown()),
              provenance: Type.Object({
                presets: Type.Array(StringSchema),
                projectConfigPath: Type.Optional(StringSchema),
              }),
              error: Type.Optional(StringSchema),
            }),
          ),
          components: Type.Array(
            Type.Object({
              storyPath: StringSchema,
              title: StringSchema,
              tags: Type.Array(StringSchema),
              exports: Type.Array(Type.Object({ exportName: StringSchema, label: Type.Optional(StringSchema) })),
              projectPath: Type.Optional(StringSchema),
              shared: Type.Boolean(),
            }),
          ),
          workspace: Type.Optional(
            Type.Object({
              configPath: StringSchema,
              settings: Type.Record(Type.String(), Type.Unknown()),
              sharedComponentTags: Type.Array(StringSchema),
            }),
          ),
          diagnostics: Type.Array(Type.Object({ path: StringSchema, message: StringSchema })),
          truncated: Type.Boolean(),
        }),
      ),
    },
    {
      id: 'style-system-preview.metadata',
      scope: 'session',
      basePath: 'style-system-preview',
      path: '/metadata',
      method: 'POST',
      authentication: 'owner',
      description: 'Read exact story exports and resolve its project without executing workspace source.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({
          storyPath: StringSchema,
          appPath: Type.Optional(StringSchema),
        }),
      },
      responses: jsonApiResponses(
        Type.Object({
          storyPath: StringSchema,
          appPath: StringSchema,
          projectResolution: Type.Union([
            Type.Literal('explicit'),
            Type.Literal('config'),
            Type.Literal('package'),
            Type.Literal('workspace'),
          ]),
          exports: Type.Array(Type.Object({ exportName: StringSchema, label: Type.Optional(StringSchema) })),
        }),
      ),
    },
    {
      id: 'style-system-preview.build',
      scope: 'session',
      basePath: 'style-system-preview',
      path: '/build',
      method: 'POST',
      authentication: 'owner',
      description: 'Build an isolated HTML preview for one exact story export.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({
          appPath: StringSchema,
          storyPath: StringSchema,
          storyExport: StringSchema,
          darkMode: Type.Optional(Type.Boolean()),
        }),
      },
      responses: jsonApiResponses(
        Type.Object({
          handle: StringSchema,
          html: StringSchema,
          storyPath: StringSchema,
          storyExport: StringSchema,
          sourceSha256: StringSchema,
        }),
      ),
    },
    {
      id: 'style-system-preview.image',
      scope: 'session',
      basePath: 'style-system-preview',
      path: '/image',
      method: 'POST',
      authentication: 'owner',
      description: 'Render a fresh source-backed PNG for one exact story export.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({
          appPath: StringSchema,
          storyPath: StringSchema,
          storyExport: StringSchema,
          darkMode: Type.Optional(Type.Boolean()),
        }),
      },
      responses: jsonApiResponses(
        Type.Object({
          data: StringSchema,
          mimeType: Type.Literal('image/png'),
          storyPath: StringSchema,
          storyExport: StringSchema,
          sourceSha256: StringSchema,
        }),
      ),
    },
    {
      id: 'style-system-preview.dispose',
      scope: 'session',
      basePath: 'style-system-preview',
      path: '/artifact',
      method: 'DELETE',
      authentication: 'owner',
      description: 'Dispose one session-owned story preview artifact.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ handle: StringSchema }),
      },
      responses: jsonApiResponses(Type.Object({ disposed: Type.Boolean() })),
    },
  ],
});
export default apiContracts;
