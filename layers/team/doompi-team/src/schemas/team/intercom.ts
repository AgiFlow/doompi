import { Type } from 'typebox';

export const TEAM_ACTIONS = ['members', 'send', 'ask', 'reply', 'pending'] as const;

/**
 * The schema declared to the model.
 *
 * A flat object rather than a per-action union. A top-level union has no
 * `properties`, and Pi's Anthropic Messages adapter rebuilds tool input as
 * `{type:'object', properties: schema.properties ?? {}, required: schema.required ?? []}`,
 * so the union arrived at the model as an empty object and calls came back as `{}`.
 * Nothing here relaxes what is accepted: `parseTeamToolParams` still rejects an
 * unknown action, a field the action does not take, and a missing required one.
 */
export const TeamToolParamsSchema = Type.Object(
  {
    action: Type.String({
      enum: [...TEAM_ACTIONS],
      description:
        'members: list active members. send: deliver a message. ask: deliver a question and return at once with a requestId; the reply arrives later as a message, and one reminder arrives if there is no reply after 3 minutes. reply: answer a question by requestId. pending: list questions waiting for your reply.',
    }),
    to: Type.Optional(Type.String({ minLength: 1, description: 'Member id to address. Actions: send, ask.' })),
    message: Type.Optional(Type.String({ minLength: 1, description: 'Text to deliver. Actions: send, ask, reply.' })),
    requestId: Type.Optional(
      Type.String({ minLength: 1, description: 'The requestId of the question being answered. Actions: reply.' }),
    ),
  },
  { additionalProperties: false },
);
