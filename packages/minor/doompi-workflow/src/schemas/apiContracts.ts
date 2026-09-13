import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const values = <T extends string>(items: T[]) => Type.Union(items.map((item) => Type.Literal(item)));
const Progress = values(['running', 'completed', 'skipped', 'failed', 'pause_requested', 'paused', 'resumed']);
const Step = { name: S, status: Progress, reason: O(S), startedAt: O(S), endedAt: O(S) };
const Run = Type.Object({
  runKey: S,
  workspace: S,
  displayName: S,
  workflowName: O(S),
  workflowPath: S,
  stage: values(['running', 'completed', 'error']),
  outcome: O(values(['success', 'skipped', 'failed', 'interrupted'])),
  executionState: O(values(['running', 'pause_requested', 'paused', 'resume_requested'])),
  prompt: O(S),
  startedAt: S,
  finishedAt: O(S),
  errorMessage: O(S),
  failedJob: O(S),
  stale: O(B),
  staleReason: O(S),
  worktreeBranch: O(S),
  position: O(Type.Object({ job: S, step: O(S), index: O(N), total: O(N) })),
  jobs: Type.Array(
    Type.Object({
      ...Step,
      phase: values(['pre', 'job', 'post']),
      index: O(N),
      total: O(N),
      steps: Type.Array(Type.Object(Step)),
    }),
  ),
});
export const WorkflowRunsSchema = Type.Object({ runs: Type.Array(Run) });
const Artifact = { path: S, kind: values(['file', 'directory']), description: S, producedBy: Type.Array(S) };
export const WorkflowCatalogSchema = Type.Object({
  cwd: S,
  warning: O(S),
  workflows: Type.Array(
    Type.Object({
      path: S,
      relativePath: S,
      name: S,
      description: S,
      tags: Type.Array(S),
      triggers: Type.Array(S),
      inputs: Type.Array(
        Type.Object({
          name: S,
          description: O(S),
          required: O(B),
          default: O(S),
          type: O(S),
          options: O(Type.Array(S)),
        }),
      ),
      jobs: Type.Array(Type.Object({ name: S, steps: Type.Array(S) })),
      artifacts: Type.Array(Type.Object(Artifact)),
      runners: O(Type.Array(S)),
      error: O(S),
    }),
  ),
});
const Screen = Type.Object({
  lines: Type.Array(S),
  capabilities: Type.Object({ readable: B, writable: B, resizable: B, reason: O(S) }),
  ended: O(B),
});
const Control = Type.Object({ held: B, token: O(S), reason: O(S) });
const root = '/runs/{workspace}/{runKey}';
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: [],
  http: (['global', 'workspace', 'session'] as const).flatMap((scope): DoomHttpContract[] => [
    {
      id: 'workflow.screen',
      scope,
      basePath: 'workflow',
      path: `${root}/screen/stream`,
      method: 'GET',
      authentication: 'owner',
      description: 'Follow the workflow terminal.',
      responses: {
        '200': {
          description: 'SSE stream with JSON screen events.',
          contentType: 'text/event-stream',
          schema: S,
          events: { screen: Screen },
        },
        '404': { description: 'Run unavailable.', schema: Type.Object({ error: S }) },
      },
    },
    {
      id: 'workflow.control',
      scope,
      basePath: 'workflow',
      path: `${root}/control`,
      method: 'POST',
      authentication: 'owner',
      description: 'Take or release the keyboard.',
      body: { required: true, contentType: 'application/json', schema: Type.Object({ release: O(B), token: O(S) }) },
      responses: { ...jsonApiResponses(Control), '409': { description: 'Keyboard unavailable.', schema: Control } },
    },
    {
      id: 'workflow.keys',
      scope,
      basePath: 'workflow',
      path: `${root}/keys`,
      method: 'POST',
      authentication: 'owner',
      description: 'Write terminal data with the control token.',
      body: { required: true, contentType: 'application/json', schema: Type.Object({ token: S, data: S }) },
      responses: {
        '204': { description: 'Data written.' },
        '400': { description: 'Invalid request.', schema: Type.Object({ error: S }) },
        '409': { description: 'Write refused.', schema: Type.Object({ error: S }) },
      },
    },
    {
      id: 'workflow.resize',
      scope,
      basePath: 'workflow',
      path: `${root}/resize`,
      method: 'POST',
      authentication: 'owner',
      description: 'Resize the terminal.',
      body: { required: true, contentType: 'application/json', schema: Type.Object({ token: S, columns: N, rows: N }) },
      responses: jsonApiResponses(Type.Object({ resized: B })),
    },
    {
      id: 'workflow.delete',
      scope,
      basePath: 'workflow',
      path: root,
      method: 'DELETE',
      authentication: 'owner',
      description: 'Delete a settled run and its directory.',
      responses: jsonApiResponses(Type.Object({ deleted: Type.Literal(true) })),
    },
    {
      id: 'workflow.artifacts',
      scope,
      basePath: 'workflow',
      path: `${root}/artifacts`,
      method: 'GET',
      authentication: 'owner',
      description: 'List declared and discovered artifacts.',
      responses: jsonApiResponses(
        Type.Object({
          runDir: S,
          description: S,
          artifacts: Type.Array(
            Type.Object({
              ...Artifact,
              declared: B,
              state: values(['written', 'empty', 'pending', 'unreadable']),
              size: O(N),
              modifiedAt: O(S),
            }),
          ),
        }),
      ),
    },
    {
      id: 'workflow.artifact',
      scope,
      basePath: 'workflow',
      path: `${root}/artifacts/{name}`,
      method: 'GET',
      authentication: 'owner',
      description:
        'Read artifact metadata and text. name may contain nested path segments. raw=1 streams binary with its media type and supports byte ranges.',
      parameters: [
        { name: 'raw', in: 'query', required: false, schema: values(['0', '1']) },
        { name: 'download', in: 'query', required: false, schema: values(['0', '1']) },
        { name: 'range', in: 'header', required: false, schema: S },
      ],
      responses: {
        ...jsonApiResponses(
          Type.Union([Type.Object({ path: S, size: N, modifiedAt: S, mimeType: O(S), text: O(S), truncated: B }), S]),
        ),
        '206': { description: 'Partial raw bytes.', contentType: 'application/octet-stream', schema: S },
        '416': { description: 'Unsatisfiable byte range.' },
      },
    },
  ]),
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'workflow.runs',
      scope,
      service: 'doompi.hub.v1',
      member: 'workflow_runs',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Workflow runs channel payload.',
      input: WorkflowRunsSchema,
    },
    {
      id: 'workflow.catalog',
      scope,
      service: 'doompi.hub.v1',
      member: 'workflow_catalog',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Workflow catalog channel payload.',
      input: WorkflowCatalogSchema,
    },
  ]),
});
export default apiContracts;
