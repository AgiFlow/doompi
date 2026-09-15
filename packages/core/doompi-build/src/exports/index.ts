export { classifySegment, type Segment } from '../services/segments';
export { parseFilename, type ParsedFilename } from '../services/filename';
export { resolveRoutingRoot, scanExtensions } from '../services/scan';
export type { ScanOptions } from '../services/scan/type';
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
  HOST_FILL_TARGETS,
  ROUTE_FILE_NAME,
  ROUTED_SURFACES,
  ROUTING_ROOT_ALIAS,
  TARGETED_SURFACES,
} from '../constants/layout';
