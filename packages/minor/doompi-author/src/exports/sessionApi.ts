export { api, createAuthorApi } from '../adapters/authorApi.ts';
export { createAuthorBridgeApi } from '../adapters/authorBridgeApi.ts';
export {
  AUTHOR_DOCUMENT_OPEN_PATH,
  AUTHOR_DOCUMENT_PREFLIGHT_PATH,
  AUTHOR_DOCUMENT_SERIALIZE_PATH,
  createAuthorDocumentApi,
} from '../adapters/authorDocumentApi.ts';
export {
  AuthorBridgeError,
  AUTHOR_OWNER_LEASE_MS,
  AUTHOR_REQUEST_TIMEOUT_MS,
  createAuthorBridgeState,
} from '../services/authorBridgeState.ts';
export type { AuthorBridgeState, AuthorBridgeStateOptions } from '../services/authorBridgeState.ts';
export { API_BASE_PATH, AUTHOR_BRIDGE_ROUTES, AUTHOR_STATE_PATH, authorStateUrl } from '../types/authorApi.ts';
export type { AuthorSessionView } from '../types/authorApi.ts';
export type * from '../types/structuredDocuments.ts';
