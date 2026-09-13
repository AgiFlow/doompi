import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const B = Type.Boolean();
const O = Type.Optional;
export const PlanDetailSchema = Type.Object({
  path: S,
  title: S,
  writtenAt: S,
  planId: O(S),
  content: S,
  hash: S,
  unavailable: B,
  reason: O(S),
});
export const apiContracts = defineApiContract({
  version: 1,
  sockets: [],
  dynamic: [],
  http: [
    {
      id: 'plan.current',
      scope: 'session',
      basePath: 'plans',
      path: '/current',
      method: 'GET',
      authentication: 'owner',
      description: 'Read the current plan.',
      responses: jsonApiResponses(PlanDetailSchema),
    },
    {
      id: 'plan.save',
      scope: 'session',
      basePath: 'plans',
      path: '/content',
      method: 'PUT',
      authentication: 'owner',
      description: 'Save the plan if its hash has not changed.',
      body: { required: true, contentType: 'application/json', schema: Type.Object({ expectedHash: S, content: S }) },
      responses: jsonApiResponses(Type.Object({ hash: S })),
    },
  ],
});
export default apiContracts;
