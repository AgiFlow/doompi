import http from 'node:http';
import { Readable } from 'node:stream';

/** Headers that describe one hop and must not be copied onto the next. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

export interface ProxyToSocketInput {
  socketPath: string;
  /** Path and query as the upstream should see them. */
  path: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
}

function outgoingHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  });
  // The upstream is a unix socket with no meaningful authority; a stable value
  // keeps its own URL parsing predictable.
  out.host = 'session.local';
  return out;
}

/**
 * Forwards one request to a session server's API socket and returns its answer.
 *
 * The response body is handed back as a stream rather than buffered, so a
 * server-sent event stream reaches the browser as it is produced instead of
 * arriving all at once when the runner finally exits.
 */
export async function proxyToSocket(input: ProxyToSocketInput): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(
      { socketPath: input.socketPath, path: input.path, method: input.method, headers: outgoingHeaders(input.headers) },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = incoming.statusCode ?? 502;
        // 204 and 304 carry no body, and constructing one with a stream throws.
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(incoming) as ReadableStream);
        resolve(new Response(body, { status, headers }));
      },
    );
    request.once('error', reject);
    if (input.body === null) {
      request.end();
      return;
    }
    void new Response(input.body)
      .arrayBuffer()
      .then((buffer) => request.end(Buffer.from(buffer)))
      .catch(reject);
  });
}
