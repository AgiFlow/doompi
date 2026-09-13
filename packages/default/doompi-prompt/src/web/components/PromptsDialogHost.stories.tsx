/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The host renders nothing until something asks for the library, and it loads
 * that library over the sealed transport, which is a plain `fetch` until a
 * tunnel handshake completes. So this file does the two things the cockpit
 * would: it answers the collection route, and it publishes one open request.
 * The request survives until the host subscribes, because
 * `subscribePromptDialogRequest` delivers the pending one on subscribe.
 *
 * ponytail: the stub answers reads only. Nothing here exercises save or
 * delete; add matching branches if a story needs the mutation states.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { API_BASE_PATH, PROMPTS_PATH } from '../../constants/webPrompts';
import { type SavedPromptListResponse } from '../../types/webPrompts';
import { requestPromptDialogOpen } from '../lib/messagePromptDraft';
import { PromptsDialogHost } from './PromptsDialogHost';

const body: SavedPromptListResponse = {
  prompts: [
    {
      name: 'ship-it',
      description: 'run the affected targets, then report what changed',
      text: 'Run the affected Nx lint, typecheck, build and test targets, then report what changed.',
    },
    {
      name: 'review-diff',
      description: 'review the working tree for concrete defects',
      text: 'Review the working tree for defects, regressions and missing tests. Name files and lines.',
    },
  ],
};

const liveFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes(`/api/plugin/${API_BASE_PATH}${PROMPTS_PATH}`)) return liveFetch(input, init);
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

const slot = slotPropsFixture({ sessionId: 's1' }).props;

requestPromptDialogOpen();

const meta = {
  title: 'Prompt/PromptsDialogHost',
  component: PromptsDialogHost,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          opened by a composer menu request, library loaded
        </span>
        <PromptsDialogHost {...slot} />
      </div>
    </div>
  ),
};
