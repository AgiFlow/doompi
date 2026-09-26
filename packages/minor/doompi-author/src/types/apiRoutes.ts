import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type { AuthorOpenFileResult } from './author';
import type { AuthorSessionView } from './authorApi';
import type { DocumentPreflightReport, ParsedStructuredDocument } from './structuredDocuments';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/workspaces/sessions/(backend)/api/author/`, so the mount is
 * stated once, by the folder that creates it. The browser used to restate it:
 * `authorStateUrl` built one URL from `API_BASE_PATH` and the document helper
 * two files away spelled `author` out again as a literal, so the two could
 * disagree and nothing would say so.
 *
 * The order below is the order the three Hono apps register in: `/state` in
 * `authorApi`, the eight bridge routes in `authorBridgeApi`, the three document
 * routes in `authorDocumentApi`. A reviewer can read the two side by side.
 *
 * Response types are named only where a caller reads the body. The bridge
 * routes are called by the hub's author channel over `requestSessionApi`, which
 * has its own message vocabulary and never sees this client.
 */
export default defineApiRoutes({
  state: {
    method: 'GET',
    path: '/state',
    response: apiResponse<AuthorSessionView>(),
  },
  bridgeRegister: {
    method: 'POST',
    path: '/bridge/register',
  },
  bridgeCatalog: {
    method: 'POST',
    path: '/bridge/catalog',
  },
  /** Long-polls for the next capability request, so it settles when one arrives. */
  bridgeNext: {
    method: 'POST',
    path: '/bridge/next',
  },
  bridgeResult: {
    method: 'POST',
    path: '/bridge/result',
  },
  bridgeCancelled: {
    method: 'POST',
    path: '/bridge/cancelled',
  },
  bridgeDisconnect: {
    method: 'POST',
    path: '/bridge/disconnect',
  },
  bridgeClose: {
    method: 'POST',
    path: '/bridge/close',
  },
  bridgeDescribe: {
    method: 'GET',
    path: '/bridge/describe',
    query: ['alias'],
  },
  bridgeInvoke: {
    method: 'POST',
    path: '/bridge/invoke',
  },
  /**
   * Parses one structured document.
   *
   * Answers a byte-length summary instead when the request names no format,
   * which is the agent-side tool path; the page always names one.
   */
  documentsOpen: {
    method: 'POST',
    path: '/documents/open',
    query: ['session'],
    response: apiResponse<ParsedStructuredDocument | AuthorOpenFileResult>(),
  },
  documentsPreflight: {
    method: 'POST',
    path: '/documents/preflight',
    query: ['session'],
    response: apiResponse<DocumentPreflightReport>(),
  },
  documentsSerialize: {
    method: 'POST',
    path: '/documents/serialize',
    query: ['session'],
    response: apiResponse<{ bytes: string; encoding: string }>(),
  },
  /**
   * The host's own bytes route, not this package's.
   *
   * `host: true` hangs it off the session root rather than under `/plugins`,
   * which is how the cockpit already serves it. Author reads a document's
   * bytes and its digest through it, and writes the edited bytes back to the
   * same path, so both stay raw transfers rather than calls: the body is the
   * file and the digest travels in a header.
   */
  file: {
    method: 'GET',
    path: '/file',
    query: ['path'],
    host: true,
  },
});
