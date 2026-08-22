import {
  VOICE_TOOL_MAX_DOMAIN_COUNT,
  VOICE_TOOL_MAX_IDENTIFIER_LENGTH,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { type Static, Type } from 'typebox';
import { SAFE_DOMAIN_NAME } from '../types/domains.ts';

export const DOMAIN_NAMES_SCHEMA = Type.Array(
  Type.String({ minLength: 1, maxLength: VOICE_TOOL_MAX_IDENTIFIER_LENGTH, pattern: SAFE_DOMAIN_NAME.source }),
  { maxItems: VOICE_TOOL_MAX_DOMAIN_COUNT },
);

export const EMPTY_DOMAIN_INPUT_SCHEMA = Type.Object({}, { additionalProperties: false });

export const LIST_DOMAINS_RESULT_SCHEMA = Type.Object(
  {
    active: DOMAIN_NAMES_SCHEMA,
    effective: DOMAIN_NAMES_SCHEMA,
    available: DOMAIN_NAMES_SCHEMA,
  },
  { additionalProperties: false },
);

export const SWITCH_DOMAINS_INPUT_SCHEMA = Type.Object(
  {
    domains: DOMAIN_NAMES_SCHEMA,
  },
  { additionalProperties: false },
);

export const SWITCH_DOMAINS_RESULT_SCHEMA = Type.Object(
  {
    status: Type.Literal('queued'),
    stopBatch: Type.Literal('session-reload'),
  },
  { additionalProperties: false },
);

export type ListDomainsResult = Static<typeof LIST_DOMAINS_RESULT_SCHEMA>;
export type SwitchDomainsInput = Static<typeof SWITCH_DOMAINS_INPUT_SCHEMA>;
export type SwitchDomainsResult = Static<typeof SWITCH_DOMAINS_RESULT_SCHEMA>;
