import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/apiContracts';
import { Type } from 'typebox';

/** The endpoint validates its own HMAC peer credential because tunnel device authentication is intentionally bypassed. */
const http: DoomHttpContract[] = [
  {
    id: 'peer-inbox',
    scope: 'global',
    basePath: 'session-peer',
    method: 'POST',
    path: '/inbox',
    authentication: 'none',
    description:
      'Accept an HMAC-authenticated durable Session delivery envelope from an explicitly configured tunnel peer.',
    body: { contentType: 'application/json', required: true, schema: Type.Unknown() },
    responses: jsonApiResponses(Type.Object({ accepted: Type.Boolean(), state: Type.String() })),
  },
];

export const apiContracts = defineApiContract({ version: 1, http, sockets: [], dynamic: [] });
export default apiContracts;
