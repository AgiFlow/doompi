import { type Static, Type } from 'typebox';
import type { DoomExtensionContext } from './config.ts';

/**
 * How the key badge is painted. `exit` marks the row that leaves an active minor
 * mode, which the panel colours differently so the reader can tell which way the
 * key flips without checking the mode line first.
 */
export const LeaderToneSchema = Type.Union([Type.Literal('default'), Type.Literal('exit')]);
export type LeaderTone = Static<typeof LeaderToneSchema>;

export const LeaderSegmentSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 1 }),
    label: Type.String({ minLength: 1 }),
    detail: Type.Optional(Type.String()),
    order: Type.Optional(Type.Integer()),
    tone: Type.Optional(LeaderToneSchema),
  },
  { additionalProperties: false },
);
export type LeaderSegment = Static<typeof LeaderSegmentSchema>;

export const LeaderCommandSchema = Type.Object(
  { name: Type.String({ minLength: 1 }), args: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
export type LeaderCommand = Static<typeof LeaderCommandSchema>;

export const LeaderActionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9][a-z0-9._:-]*$' }),
  },
  { additionalProperties: false },
);
export type LeaderAction = Static<typeof LeaderActionSchema>;

const LeaderBindingBase = {
  id: Type.String({ minLength: 1 }),
  path: Type.Array(LeaderSegmentSchema, { minItems: 1 }),
};

export const LeaderBindingSchema = Type.Union([
  Type.Object({ ...LeaderBindingBase, command: LeaderCommandSchema }, { additionalProperties: false }),
  Type.Object({ ...LeaderBindingBase, action: LeaderActionSchema }, { additionalProperties: false }),
]);
export type LeaderBinding =
  | {
      id: string;
      path: readonly [LeaderSegment, ...LeaderSegment[]];
      command: LeaderCommand;
    }
  | {
      id: string;
      path: readonly [LeaderSegment, ...LeaderSegment[]];
      action: LeaderAction;
    };

export const LeaderSourceSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$',
});

export const LeaderContributionSchema = Type.Object(
  {
    source: LeaderSourceSchema,
    bindings: Type.Array(LeaderBindingSchema),
  },
  { additionalProperties: false },
);
export interface LeaderContribution {
  source: string;
  bindings: readonly LeaderBinding[];
}

export interface DoomLeaderContributionHandle {
  update(bindings: readonly LeaderBinding[]): void;
  dispose(): void;
}

export interface DoomLeaderActionHandlerOptions<ExtensionContext extends DoomExtensionContext = DoomExtensionContext> {
  source: string;
  handlers: Readonly<Record<string, (context: ExtensionContext) => void | Promise<void>>>;
  onError: (error: unknown, actionName: string, context: ExtensionContext) => void;
}
