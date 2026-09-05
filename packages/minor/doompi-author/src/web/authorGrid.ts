import { defineGlobalStore } from '@agimon-ai/doompi-web-contracts';
import type { AuthorNativeAnchor, AuthorVoiceGridEvidence, AuthorViewportSnapshot } from './authorViewportTypes.ts';

export const AUTHOR_GRID_COLUMNS = 'ABCDEFGH' as const;
export const AUTHOR_GRID_SIZE = 8;

export interface AuthorGridGeometry {
  documentPath: string;
  revision: number;
  sourceSha256?: string;
  geometryToken: string;
  snapshotId: string;
  viewport: AuthorViewportSnapshot;
  updatedAt: number;
}

interface AuthorGridState {
  sessions: Readonly<Record<string, AuthorGridGeometry>>;
}

export interface AuthorGridCellResolution {
  cell: string;
  column: number;
  row: number;
  rect: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  evidence: AuthorVoiceGridEvidence;
}

export interface AuthorGridNativeResolution {
  anchor: AuthorNativeAnchor;
  quote?: string;
}

type AuthorGridNativeResolver = (
  cell: AuthorGridCellResolution,
  geometry: AuthorGridGeometry,
) => AuthorGridNativeResolution | undefined;

const nativeResolvers = new Map<string, AuthorGridNativeResolver>();

export const authorGrid = defineGlobalStore<AuthorGridState>({ sessions: {} });

export function parseAuthorGridCell(cell: string): { cell: string; column: number; row: number } {
  const normalized = cell.trim().toUpperCase();
  if (!/^[A-H][1-8]$/u.test(normalized)) throw new Error(`Invalid Author grid cell '${cell}'. Expected A1 through H8.`);
  return {
    cell: normalized,
    column: AUTHOR_GRID_COLUMNS.indexOf(normalized[0] as (typeof AUTHOR_GRID_COLUMNS)[number]),
    row: Number(normalized[1]) - 1,
  };
}

export function updateAuthorGridGeometry(
  sessionId: string,
  input: Omit<AuthorGridGeometry, 'geometryToken' | 'snapshotId' | 'updatedAt'>,
): AuthorGridGeometry {
  const previous = authorGrid.store.state.sessions[sessionId];
  const geometry: AuthorGridGeometry = {
    ...input,
    geometryToken: crypto.randomUUID(),
    snapshotId:
      previous?.documentPath === input.documentPath &&
      previous.revision === input.revision &&
      previous.sourceSha256 === input.sourceSha256
        ? previous.snapshotId
        : crypto.randomUUID(),
    updatedAt: Date.now(),
  };
  authorGrid.update((state) => ({ ...state, sessions: { ...state.sessions, [sessionId]: geometry } }));
  return geometry;
}

export function authorGridGeometry(sessionId: string): AuthorGridGeometry | undefined {
  return authorGrid.store.state.sessions[sessionId];
}

export function clearAuthorGridGeometry(sessionId: string): void {
  authorGrid.update((state) => {
    if (state.sessions[sessionId] === undefined) return state;
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { ...state, sessions };
  });
}

export function registerAuthorGridResolver(sessionId: string, resolver: AuthorGridNativeResolver): () => void {
  nativeResolvers.set(sessionId, resolver);
  return () => {
    if (nativeResolvers.get(sessionId) === resolver) nativeResolvers.delete(sessionId);
  };
}

export function resolveAuthorGridNativeAnchor(
  sessionId: string,
  cell: AuthorGridCellResolution,
): AuthorGridNativeResolution {
  const geometry = authorGridGeometry(sessionId);
  const resolved = geometry === undefined ? undefined : nativeResolvers.get(sessionId)?.(cell, geometry);
  if (resolved === undefined)
    throw new Error('AMBIGUOUS_GRID: The grid cell does not resolve to one visible native document target.');
  return resolved;
}

export function resolveAuthorGridCell(
  sessionId: string,
  cell: string,
  expectedGeometryToken: string,
): AuthorGridCellResolution {
  const geometry = authorGridGeometry(sessionId);
  if (geometry === undefined || geometry.geometryToken !== expectedGeometryToken) {
    throw new Error('STALE_GRID: The Author grid geometry changed. Describe the grid again.');
  }
  const parsed = parseAuthorGridCell(cell);
  const width = 1 / AUTHOR_GRID_SIZE;
  const height = 1 / AUTHOR_GRID_SIZE;
  const rect = { x: parsed.column * width, y: parsed.row * height, width, height };
  return {
    ...parsed,
    rect,
    center: { x: rect.x + width / 2, y: rect.y + height / 2 },
    evidence: { cell: parsed.cell, geometryToken: geometry.geometryToken, snapshotId: geometry.snapshotId },
  };
}
