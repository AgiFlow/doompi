import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

export const LoopListSchema = Type.Object({}, { additionalProperties: false });
export const LoopStartSchema = Type.Object(
  {
    launcherId: Type.String({ minLength: 1, maxLength: 256 }),
    instanceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    input: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export const LoopStopSchema = Type.Object(
  {
    instanceId: Type.String({ minLength: 1, maxLength: 256 }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const IntervalLoopSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 32768 }),
    intervalSeconds: Type.Integer({ minimum: 30, maximum: 3600 }),
  },
  { additionalProperties: false },
);
export const CronLoopSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 32768 }),
    cron: Type.String({ minLength: 1, maxLength: 256 }),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type IntervalLoopInput = Static<typeof IntervalLoopSchema>;
export type CronLoopInput = Static<typeof CronLoopSchema>;

export function parseIntervalLoop(input: unknown): IntervalLoopInput {
  if (!Check(IntervalLoopSchema, input) || !input.prompt.trim()) {
    throw new Error('Provide a non-empty prompt and an integer intervalSeconds between 30 and 3600.');
  }
  return { ...input, prompt: input.prompt.trim() };
}

export function parseCronLoop(input: unknown): CronLoopInput {
  if (!Check(CronLoopSchema, input) || !input.prompt.trim() || input.cron.trim().split(/\s+/u).length !== 5) {
    throw new Error('Provide a non-empty prompt and a five-field cron expression, with an optional IANA timezone.');
  }
  const timezone = input.timezone ?? 'UTC';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return { ...input, prompt: input.prompt.trim(), cron: input.cron.trim(), timezone };
}
