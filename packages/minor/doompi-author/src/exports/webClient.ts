export { AuthorClientBroker } from '../web/authorBroker.ts';
export { authorFileTab } from '../web/AuthorDocumentPanel.tsx';
export { AuthorRuntime, AUTHOR_RUNTIME_BINDING_IDS } from '../web/AuthorRuntime.ts';
export { AUTHOR_TRUSTED_PROFILES } from '../web/authorProfiles.ts';
export {
  addAuthorAnnotation,
  authorDocument,
  authorWorkspace,
  dropAuthorSession,
  normalizeAuthorPath,
  putAuthorDocument,
  requestAuthorSave,
  reviseAuthorDocument,
  setAuthorCrop,
} from '../web/authorWorkspaceStore.ts';
export { webPlugin } from '../web/index.ts';
export type {
  AuthorAnnotation,
  AuthorCrop,
  AuthorDocumentInput,
  AuthorDocumentKind,
  AuthorDraftRevision,
  AuthorTrustedProfile,
  AuthorTrustedTool,
} from '../web/authorViewportTypes.ts';
