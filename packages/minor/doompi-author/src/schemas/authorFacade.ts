import { type Static, Type } from 'typebox';
import { defineDoomPluginMethod } from '@agimon-ai/doompi-core/plugin-protocol';
import type { DoomApiScope } from '@agimon-ai/doompi-core/package-api';

const AuthorCapabilityNameSchema = Type.String({
  minLength: 1,
  maxLength: 30,
  pattern: '^[a-z][a-z0-9_]*$',
});

/** Lists the capabilities exposed by the current Author viewport. */
export const AuthorDescribeToolsInputSchema = Type.Object({}, { additionalProperties: false });
export type AuthorDescribeToolsInput = Static<typeof AuthorDescribeToolsInputSchema>;

/** Invokes one capability exposed by the current Author viewport. */
export const AuthorUseToolsInputSchema = Type.Object(
  {
    catalogToken: Type.String({ minLength: 1, maxLength: 256 }),
    name: AuthorCapabilityNameSchema,
    arguments: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type AuthorUseToolsInput = Static<typeof AuthorUseToolsInputSchema>;

const AuthorBridgeBase = {
  generation: Type.Number({ minimum: 0 }),
};

/** Browser-to-server lease messages, validated before Author sees the payload. */
export const AuthorBridgeMessageSchema = Type.Union([
  Type.Object({ ...AuthorBridgeBase, kind: Type.Literal('register') }, { additionalProperties: false }),
  Type.Object({ ...AuthorBridgeBase, kind: Type.Literal('release') }, { additionalProperties: false }),
  Type.Object(
    {
      ...AuthorBridgeBase,
      kind: Type.Literal('catalog'),
      ownerToken: Type.String({ minLength: 1 }),
      tools: Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            label: Type.String(),
            description: Type.String(),
            inputSchema: Type.Record(Type.String(), Type.Unknown()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AuthorBridgeBase,
      kind: Type.Literal('result'),
      ownerToken: Type.String({ minLength: 1 }),
      catalogToken: Type.String({ minLength: 1 }),
      requestId: Type.String({ minLength: 1 }),
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AuthorBridgeBase,
      kind: Type.Literal('cancelled'),
      ownerToken: Type.String({ minLength: 1 }),
      catalogToken: Type.String({ minLength: 1 }),
      requestId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const AuthorBridgeInputSchema = Type.Object(
  { sessionId: Type.String({ minLength: 1 }), message: AuthorBridgeMessageSchema },
  { additionalProperties: false },
);

export function authorBridgeMethod(scope: Extract<DoomApiScope, 'global' | 'workspace'>) {
  return defineDoomPluginMethod({
    service: 'author.bridge',
    method: 'send',
    scope,
    direction: 'client-to-server',
    input: AuthorBridgeInputSchema,
    output: Type.Object({}, { additionalProperties: false }),
  });
}
