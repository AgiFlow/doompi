export { AuthorClientBroker } from '../web/authorBroker.ts';
export { authorFileTab } from '../web/AuthorDocumentPanel.tsx';
export { AuthorRuntime, AUTHOR_RUNTIME_BINDING_IDS } from '../web/AuthorRuntime.ts';
export { AUTHOR_TRUSTED_PROFILES } from '../web/authorProfiles.ts';
export {
  addAuthorAnnotation,
  addAuthorRegion,
  authorDocument,
  authorSessionWorkspace,
  authorWorkspace,
  dropAuthorSession,
  focusAuthorDocument,
  normalizeAuthorPath,
  putAuthorDocument,
  putAuthorRequest,
  releaseAuthorDocumentFocus,
  removeAuthorRegion,
  requestAuthorSave,
  reviseAuthorDocument,
  setAuthorCrop,
  syncAuthorDocumentFocus,
  updateAuthorRegionComment,
  updateAuthorRequest,
} from '../web/authorWorkspaceStore.ts';
export { webPlugin } from '../web/index.ts';
export type {
  AuthorAnnotation,
  AuthorCellAnchor,
  AuthorCrop,
  AuthorDocumentInput,
  AuthorDocumentKind,
  AuthorDraftRevision,
  AuthorFocusedDocument,
  AuthorImageRectAnchor,
  AuthorNativeAnchor,
  AuthorNormalizedRect,
  AuthorPdfPageRectAnchor,
  AuthorRegionDraft,
  AuthorRequestRecord,
  AuthorRequestStatus,
  AuthorSlideElementAnchor,
  AuthorTextRangeAnchor,
  AuthorTrustedProfile,
  AuthorTrustedTool,
  AuthorVideoTimeRectAnchor,
  AuthorViewportSnapshot,
  AuthorVoiceGridEvidence,
} from '../web/authorViewportTypes.ts';
