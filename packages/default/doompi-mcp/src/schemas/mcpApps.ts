import { defineDoomPluginMethod } from '@agimon-ai/doompi-core/pluginProtocol';
import { Type } from 'typebox';

export type { McpAppOpenResult } from '../types/webMcp';

const Lease = Type.String({ minLength: 1, maxLength: 128 });
const JsonObject = Type.Record(Type.String(), Type.Unknown());
const Empty = Type.Object({}, { additionalProperties: false });
const Result = Type.Object({
  content: Type.Array(Type.Unknown()),
  structuredContent: Type.Optional(Type.Unknown()),
  _meta: Type.Optional(JsonObject),
  isError: Type.Optional(Type.Boolean()),
});
const Address = { service: 'mcp.apps', scope: 'session', direction: 'client-to-server' } as const;

export const mcpAppOpenMethod = defineDoomPluginMethod({
  ...Address,
  method: 'open',
  input: Type.Object({ toolCallId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
  output: Type.Object({
    leaseId: Lease,
    html: Type.String(),
    resourceUri: Type.String(),
    protocol: Type.Union([Type.Literal('mcp'), Type.Literal('openai')]),
    resourceMeta: JsonObject,
    tool: Type.Object({
      name: Type.String(),
      description: Type.String(),
      inputSchema: Type.Object({ type: Type.Literal('object') }, { additionalProperties: true }),
      _meta: JsonObject,
    }),
    args: JsonObject,
    result: Result,
    state: Type.Unknown(),
    readOnly: Type.Boolean(),
  }),
});

export const mcpAppActivateMethod = defineDoomPluginMethod({
  ...Address,
  method: 'activate',
  input: Type.Object({ leaseId: Lease }, { additionalProperties: false }),
  output: Type.Object({ readOnly: Type.Literal(false) }),
});
export const mcpAppCallToolMethod = defineDoomPluginMethod({
  ...Address,
  method: 'callTool',
  input: Type.Object(
    { leaseId: Lease, name: Type.String({ minLength: 1, maxLength: 256 }), arguments: JsonObject },
    { additionalProperties: false },
  ),
  output: Result,
});
export const mcpAppSetStateMethod = defineDoomPluginMethod({
  ...Address,
  method: 'setState',
  input: Type.Object({ leaseId: Lease, state: Type.Unknown() }, { additionalProperties: false }),
  output: Empty,
});
export const mcpAppFollowUpMethod = defineDoomPluginMethod({
  ...Address,
  method: 'followUp',
  input: Type.Object(
    { leaseId: Lease, prompt: Type.String({ minLength: 1, maxLength: 16000 }) },
    { additionalProperties: false },
  ),
  output: Empty,
});
export const mcpAppCloseMethod = defineDoomPluginMethod({
  ...Address,
  method: 'close',
  input: Type.Object({ leaseId: Lease }, { additionalProperties: false }),
  output: Empty,
});
export const mcpAppMethods = [
  mcpAppOpenMethod,
  mcpAppActivateMethod,
  mcpAppCallToolMethod,
  mcpAppSetStateMethod,
  mcpAppFollowUpMethod,
  mcpAppCloseMethod,
] as const;
