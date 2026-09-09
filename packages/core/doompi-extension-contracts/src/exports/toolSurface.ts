export type {
  DoomToolRestriction,
  DoomToolRestrictionDefinition,
  DoomToolRestrictionHandle,
  DoomToolSurfaceService,
} from '../schemas/toolSurface.ts';
export { DOOM_TOOL_SURFACE_SERVICE, readDoomToolSurface, requireDoomToolSurface } from '../schemas/toolSurface.ts';
export { createDoomToolSurface, type CreateDoomToolSurfaceOptions } from '../services/toolSurface.ts';
