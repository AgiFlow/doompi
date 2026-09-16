/**
 * A transport a story or a test hands to a generated client.
 *
 * Keyed off the client's own methods rather than off a substring of a URL.
 * That is the whole point: the cockpit accumulated matchers like
 * `url.includes('/api/plugins/file-edits/detail')`, and when the real route
 * moved under a workspace prefix they silently stopped matching. Three of them
 * were still in the tree, one of them answering a JSON route with a binary
 * blob, because a matcher that never fires looks exactly like one that does.
 *
 * Here a matcher is the method itself, so renaming a route is a type error and
 * deleting one is a missing property. A request nothing matched throws instead
 * of falling through to the next matcher, because falling through is how the
 * wrong fixture gets served.
 */

import type { ApiMethod, ApiStreamMethod, ApiTransport } from '../apiClient';

const ORIGIN = 'http://cockpit.test';

/** What a matcher answers with: a Response, or a value sent as JSON 200. */
export type RpcStubReply = Response | Promise<Response> | unknown;

export interface RpcStubRequest {
  readonly url: URL;
  readonly method: string;
  readonly init: RequestInit | undefined;
}

/** One request the stub carried, in order, for assertions after the fact. */
export interface RpcStubCall {
  readonly method: string;
  readonly url: string;
}

export interface RpcStub {
  /** Hand this to `createApiClient`. */
  readonly transport: ApiTransport;
  /** Answer one route. Chainable, so a story reads as a list of fixtures. */
  on(call: ApiMethod<never> | ApiStreamMethod, reply: (request: RpcStubRequest) => RpcStubReply): RpcStub;
  /** Every request the stub carried, matched or not. */
  readonly calls: readonly RpcStubCall[];
}

interface Matcher {
  readonly method: string;
  readonly pathname: string;
  readonly reply: (request: RpcStubRequest) => RpcStubReply;
}

function toResponse(reply: RpcStubReply): Response | Promise<Response> {
  if (reply instanceof Response || reply instanceof Promise) return reply as Response | Promise<Response>;
  return Response.json(reply as Record<string, unknown>);
}

export function createRpcStub(): RpcStub {
  const matchers: Matcher[] = [];
  const calls: RpcStubCall[] = [];

  const stub: RpcStub = {
    calls,
    on(call, reply) {
      // `url()` with no query gives the route's pathname, which is what
      // identifies it. The query is the caller's, and a fixture that cared
      // about it can read it off the request.
      matchers.push({ method: call.spec.method, pathname: new URL(call.url(), ORIGIN).pathname, reply });
      return stub;
    },
    transport: (input, init) => {
      const url = new URL(input, ORIGIN);
      const method = init?.method ?? 'GET';
      calls.push({ method, url: input });
      const matched = matchers.find(
        (matcher) => matcher.method === method && matcher.pathname === url.pathname,
      );
      if (matched === undefined) {
        const known = matchers.map((matcher) => `${matcher.method} ${matcher.pathname}`).join(', ');
        throw new Error(
          `No stub answers ${method} ${url.pathname}. Registered: ${known === '' ? '(none)' : known}.`,
        );
      }
      return Promise.resolve(toResponse(matched.reply({ url, method, init })));
    },
  };
  return stub;
}
