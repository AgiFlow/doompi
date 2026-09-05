export { AuthorClientBroker } from '../web/authorBroker.ts';
export { authorFileTab } from '../web/AuthorDocumentPanel.tsx';
export { AuthorRuntime, AUTHOR_RUNTIME_BINDING_IDS } from '../web/AuthorRuntime.ts';
export { AUTHOR_TRUSTED_PROFILES } from '../web/authorProfiles.ts';
export {
  AUTHOR_CAPTURE_MAX_BYTES,
  AUTHOR_CAPTURE_MAX_DIMENSION,
  AUTHOR_COMMENT_MAX_BYTES,
  AUTHOR_PACKET_MAX_BYTES,
  AUTHOR_QUOTE_MAX_BYTES,
  attachAuthorCapture,
  authorCaptureContext,
  createAuthorCapturePacket,
  imageCaptureProvider,
  multiRegionCaptureProvider,
} from '../web/authorCapture.ts';
export type { AuthorCapturePacket, AuthorCapturePacketRegion, AuthorCaptureProvider } from '../web/authorCapture.ts';
export {
  AUTHOR_GRID_COLUMNS,
  AUTHOR_GRID_SIZE,
  authorGrid,
  authorGridGeometry,
  clearAuthorGridGeometry,
  parseAuthorGridCell,
  resolveAuthorGridCell,
  updateAuthorGridGeometry,
} from '../web/authorGrid.ts';
export type { AuthorGridCellResolution, AuthorGridGeometry } from '../web/authorGrid.ts';
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
