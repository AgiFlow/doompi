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

/**
 * What a matcher answers with.
 *
 * A `Response` is sent as-is, so a fixture can set a status, a header or raw
 * bytes. Anything else is sent as JSON 200, which is what most fixtures want
 * and saves them wrapping every object. Deliberately `unknown` rather than a
 * union naming `Response`: the union would collapse to this anyway, and the
 * runtime check is what actually decides.
 */
export type RpcStubReply = unknown;

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
  /** Requests no matcher claimed. Answered 599 rather than served a neighbour's fixture. */
  readonly misses: readonly RpcStubCall[];
  /** Fails the test naming every unmatched request. Call it at the end of one. */
  assertNoMisses(): void;
}

interface Matcher {
  readonly method: string;
  readonly pathname: string;
  readonly reply: (request: RpcStubRequest) => RpcStubReply;
}

function describeMiss(method: string, pathname: string, matchers: readonly Matcher[]): string {
  const known = matchers.map((matcher) => `${matcher.method} ${matcher.pathname}`).join(', ');
  return `No stub answers ${method} ${pathname}. Registered: ${known === '' ? '(none)' : known}.`;
}

function toResponse(reply: RpcStubReply): Response | Promise<Response> {
  if (reply instanceof Response || reply instanceof Promise) return reply as Response | Promise<Response>;
  return Response.json(reply as Record<string, unknown>);
}

export function createRpcStub(): RpcStub {
  const matchers: Matcher[] = [];
  const calls: RpcStubCall[] = [];
  const misses: RpcStubCall[] = [];

  const stub: RpcStub = {
    calls,
    misses,
    assertNoMisses() {
      if (misses.length === 0) return;
      const listed = misses.map((miss) => `${miss.method} ${miss.url}`).join('\n  ');
      throw new Error(`The stub was asked for routes it does not answer:\n  ${listed}`);
    },
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
      const matched = matchers.find((matcher) => matcher.method === method && matcher.pathname === url.pathname);
      if (matched === undefined) {
        misses.push({ method, url: input });
        // Not a throw: the client turns a transport throw into `status: 0`,
        // which reads as an unreachable session and is exactly the quiet
        // outcome this stub exists to prevent. 599 is outside the range any
        // route answers, so it cannot be mistaken for the real thing, and the
        // miss is recorded for `assertNoMisses`.
        return Promise.resolve(Response.json({ error: describeMiss(method, url.pathname, matchers) }, { status: 599 }));
      }
      return Promise.resolve(toResponse(matched.reply({ url, method, init })));
    },
  };
  return stub;
}
