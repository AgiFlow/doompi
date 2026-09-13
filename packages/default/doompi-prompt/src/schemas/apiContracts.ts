import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const B = Type.Boolean();
const Prompt = Type.Object({ name: S, description: S, text: S });
export const apiContracts = defineApiContract({
  version: 1,
  sockets: [],
  dynamic: [],
  http: (['global', 'workspace', 'session'] as const).flatMap((scope) => [
    {
      id: 'prompts.list',
      scope,
      basePath: 'prompts',
      path: '/prompts',
      method: 'GET',
      authentication: 'owner',
      description: 'List prompts in this scope.',
      responses: jsonApiResponses(Type.Object({ prompts: Type.Array(Prompt) })),
    },
    {
      id: 'prompts.save',
      scope,
      basePath: 'prompts',
      path: '/prompts/{name}',
      method: 'PUT',
      authentication: 'owner',
      description: 'Save a prompt. Text is limited to 65536 UTF-8 bytes.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ text: Type.String({ minLength: 1 }) }),
      },
      responses: {
        ...jsonApiResponses(Type.Object({ prompt: Prompt, replaced: B })),
        '413': { description: 'Prompt text exceeds the byte limit.', schema: Type.Object({ error: S }) },
      },
    },
    {
      id: 'prompts.delete',
      scope,
      basePath: 'prompts',
      path: '/prompts/{name}',
      method: 'DELETE',
      authentication: 'owner',
      description: 'Delete a prompt.',
      responses: jsonApiResponses(Type.Object({ name: S })),
    },
  ]),
});
export default apiContracts;
