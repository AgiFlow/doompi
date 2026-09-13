import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const Tool = literals(['edit', 'write', 'bash', 'user']);
const Hunk = Type.Object({
  start: N,
  rows: Type.Array(Type.Object({ marker: literals(['+', '-', ' ']), line: N, content: S })),
});
const Diff = { additions: N, removals: N, hunks: O(Type.Array(Hunk)), note: O(S) };
const Working = Type.Object({ content: S, hash: S, unavailable: B, reason: O(S) });
export const FileDetailSchema = Type.Object({
  path: S,
  relPath: S,
  versions: Type.Array(Type.Object({ index: N, tool: Tool, at: N, origin: literals(['tool', 'scan']), ...Diff })),
  cumulative: Type.Object(Diff),
  working: Working,
});
export const FilesPayloadSchema = Type.Object({
  items: Type.Array(Type.Object({ path: S, relPath: S, tool: Tool, at: N, count: N, diffable: B })),
});
const query = [{ name: 'path', in: 'query' as const, required: true, schema: Type.String({ minLength: 1 }) }];
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: [],
  http: [
    {
      id: 'files.detail',
      scope: 'session',
      basePath: 'file-edits',
      path: '/detail',
      method: 'GET',
      authentication: 'owner',
      description: 'Read recorded changes and current file content.',
      parameters: query,
      responses: jsonApiResponses(FileDetailSchema),
    },
    {
      id: 'files.preview',
      scope: 'session',
      basePath: 'file-edits',
      path: '/preview',
      method: 'GET',
      authentication: 'owner',
      description: 'Read a file contained in the session directory.',
      parameters: query,
      responses: jsonApiResponses(Type.Object({ path: S, relPath: S, working: Working })),
    },
    {
      id: 'files.save',
      scope: 'session',
      basePath: 'file-edits',
      path: '/content',
      method: 'PUT',
      authentication: 'owner',
      description: 'Save a recorded file if its hash still matches.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ path: S, expectedHash: S, content: S }),
      },
      responses: jsonApiResponses(Type.Object({ hash: S })),
    },
    {
      id: 'files.delete',
      scope: 'session',
      basePath: 'file-edits',
      path: '/content',
      method: 'DELETE',
      authentication: 'owner',
      description: 'Delete a recorded file.',
      parameters: query,
      responses: {
        '204': { description: 'File deleted or already absent.' },
        '404': { description: 'Unrecorded file.', schema: Type.Object({ error: S }) },
        '409': { description: 'Deletion failed.', schema: Type.Object({ error: S }) },
      },
    },
  ],
  sockets: (['global', 'workspace'] as const).map((scope) => ({
    id: 'files.channel',
    scope,
    service: 'doompi.hub.v1',
    member: 'file_edits',
    kind: 'channel',
    direction: 'server-to-client',
    description: 'File edits channel payload in the hub frame payload property.',
    input: FilesPayloadSchema,
  })),
});
export default apiContracts;
