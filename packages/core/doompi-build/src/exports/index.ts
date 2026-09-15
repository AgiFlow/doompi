export { classifySegment, type Segment } from '../services/segments';
export { parseFilename, type ParsedFilename } from '../services/filename';
export { resolveRoutingRoot, scanExtensions } from '../services/scan';
export type { ScanOptions } from '../services/scan/type';
export { resolveTarget } from '../services/resolveTarget';
export type { BuildTarget, ResolvedContribution, TargetResolution } from '../services/resolveTarget/type';
export type {
  ExtensionEntry,
  ExtensionGate,
  ExtensionGraph,
  ExtensionNotice,
  ExtensionScope,
  ExtensionSide,
  RouteParam,
  RouteSegment,
} from '../types/extensionGraph';
export {
  BACKEND_PLATFORMS,
  BACKEND_SURFACES,
  DEFAULT_ROUTING_ROOT,
  ESCAPE_HATCH_NAME,
  FRONTEND_PLATFORMS,
  FRONTEND_SURFACES,
  GATE_SEGMENTS,
  GENERATED_DIR,
  ROUTE_FILE_NAME,
  ROUTED_SURFACES,
  ROUTING_ROOT_ALIAS,
  TARGETED_SURFACES,
} from '../constants/layout';
export { generateExtension, defaultPluginId } from '../services/generate';
export type { GenerateOptions, GenerateResult } from '../services/generate/type';
export { renderCliEntry, renderServerEntry, renderWebEntry } from '../services/renderEntry';
export type { RenderOptions } from '../services/renderEntry/type';
export { StaleGeneratedError, writeGenerated } from '../services/writeGenerated';
export type { WriteResult } from '../services/writeGenerated';
export { syncManifest, writeManifest } from '../services/syncManifest';
export type { ManifestSync } from '../services/syncManifest/type';
