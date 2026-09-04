import { type Static, Type } from 'typebox';

/** The two stable Pi tools that expose the active Author viewport. */
export const AUTHOR_DESCRIBE_TOOL_NAME = 'describe_author_tools' as const;
export const AUTHOR_USE_TOOL_NAME = 'use_author_tools' as const;
export const AUTHOR_FACADE_TOOL_NAMES = [AUTHOR_DESCRIBE_TOOL_NAME, AUTHOR_USE_TOOL_NAME] as const;

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
