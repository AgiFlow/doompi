import type { AuthorJsonSchema } from '../types/author.ts';
import { authorGridGeometry, resolveAuthorGridCell, resolveAuthorGridNativeAnchor } from './authorGrid.ts';
import type {
  AuthorDocumentKind,
  AuthorNativeAnchor,
  AuthorRegionDraft,
  AuthorTrustedTool,
} from './authorViewportTypes.ts';
import {
  addAuthorRegion,
  authorDocument,
  authorSessionWorkspace,
  putAuthorRequest,
  reviseAuthorDocument,
  reviseAuthorFragment,
  setAuthorCrop,
  updateAuthorRequest,
} from './authorWorkspaceStore.ts';

const stringProperty = { type: 'string', minLength: 1 } as const;

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected an object.');
  return input as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== 'string' || value[name] === '') throw new Error(`${name} must be a non-empty string.`);
  return value[name];
}

function resolvedAnchor(
  sessionId: string,
  path: string,
  kind: AuthorDocumentKind,
  cell: ReturnType<typeof resolveAuthorGridCell>,
): { anchor: AuthorNativeAnchor; quote?: string } {
  const document = authorDocument(sessionId, path);
  if (document === undefined) throw new Error('STALE_DOCUMENT: The focused Author document is no longer open.');
  if (kind === 'pdf' || kind === 'video' || kind === 'opaque') {
    throw new Error(
      'UNSUPPORTED_GRID: PDF and video coordinates are capture-only and require a visible native selection.',
    );
  }
  return resolveAuthorGridNativeAnchor(sessionId, cell);
}

function checkedRegion(sessionId: string, path: string, value: Record<string, unknown>) {
  const document = authorDocument(sessionId, path);
  if (document === undefined) throw new Error('STALE_DOCUMENT: The Author document is no longer open.');
  if (document.savingVersion !== undefined)
    throw new Error('SAVE_IN_PROGRESS: Wait for the current Author save to finish.');
  const expectedRevision = value.expectedRevision;
  const expectedSourceSha256 = requiredString(value, 'expectedSourceSha256');
  if (expectedRevision !== document.version || expectedSourceSha256 !== document.sourceSha256) {
    throw new Error('STALE_DOCUMENT: The Author revision or source digest changed.');
  }
  const regionId = requiredString(value, 'regionId');
  const workspace = authorSessionWorkspace(sessionId);
  const region =
    workspace.regions.find((candidate) => candidate.id === regionId) ??
    workspace.requests
      .filter((request) => request.status === 'REQUESTED' || request.status === 'CHANGING')
      .flatMap((request) => request.pendingRegions ?? request.regions)
      .find((candidate) => candidate.id === regionId);
  if (region === undefined || region.documentPath !== path)
    throw new Error('STALE_REGION: The resolved Author region is unavailable.');
  if (region.revision !== document.version || region.sourceSha256 !== document.sourceSha256) {
    throw new Error('STALE_REGION: The resolved Author region no longer matches the document.');
  }
  return { document, region };
}

function gridTools(sessionId: string, path: string, kind: AuthorDocumentKind): AuthorTrustedTool[] {
  const describeSchema: AuthorJsonSchema = { type: 'object', additionalProperties: false, properties: {} };
  return [
    {
      name: 'author_describe_grid',
      label: 'Describe grid',
      description: 'Describe the current A1 through H8 grid and return its geometry token.',
      inputSchema: describeSchema,
      execute: async () => {
        const geometry = authorGridGeometry(sessionId);
        const document = authorDocument(sessionId, path);
        if (
          geometry === undefined ||
          document === undefined ||
          geometry.documentPath !== path ||
          geometry.revision !== document.version
        ) {
          throw new Error('STALE_GRID: The visible Author grid is unavailable.');
        }
        return { columns: 'A-H', rows: '1-8', ...geometry };
      },
    },
    {
      name: 'author_resolve_grid_cell',
      label: 'Resolve grid cell',
      description: 'Resolve one current grid cell to a native document anchor before mutation.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['cell', 'geometryToken', 'instruction'],
        properties: { cell: stringProperty, geometryToken: stringProperty, instruction: stringProperty },
      },
      execute: async (input) => {
        const value = inputRecord(input);
        const instruction = requiredString(value, 'instruction');
        const cell = resolveAuthorGridCell(
          sessionId,
          requiredString(value, 'cell'),
          requiredString(value, 'geometryToken'),
        );
        const geometry = authorGridGeometry(sessionId)!;
        const resolved = resolvedAnchor(sessionId, path, kind, cell);
        const regionId = crypto.randomUUID();
        const createdAt = Date.now();
        const region = {
          id: regionId,
          documentPath: path,
          revision: geometry.revision,
          sourceSha256: geometry.sourceSha256,
          comment: instruction,
          ...resolved,
          viewport: { ...geometry.viewport },
          voiceGrid: cell.evidence,
          createdAt,
        };
        addAuthorRegion(sessionId, region);
        putAuthorRequest(sessionId, {
          id: `voice:${regionId}`,
          documentPath: path,
          requestText: instruction,
          regions: [region],
          pendingRegions: [region],
          status: 'REQUESTED',
          createdAt,
          updatedAt: createdAt,
          revision: geometry.revision,
          sourceSha256: geometry.sourceSha256,
        });
        return { regionId, anchor: resolved.anchor, quote: resolved.quote, evidence: cell.evidence };
      },
    },
  ];
}

interface MutationResult {
  changed: true;
  before?: string;
  after?: string;
  crop?: unknown;
  revision: number;
}

function assertRebasable(pending: readonly AuthorRegionDraft[], changed: AuthorRegionDraft): void {
  const remaining = pending.filter((region) => region.id !== changed.id);
  if (changed.anchor.kind === 'image-rect' && remaining.length > 0)
    throw new Error('UNSUPPORTED_REGION: A multi-region image request cannot apply more than one crop.');
  if (changed.anchor.kind !== 'text-range') return;
  for (const region of remaining) {
    if (region.anchor.kind !== 'text-range') continue;
    const separate =
      region.anchor.endOffset <= changed.anchor.startOffset || region.anchor.startOffset >= changed.anchor.endOffset;
    if (!separate) throw new Error('AMBIGUOUS_REGION: Submitted text regions overlap and cannot be safely rebased.');
  }
}

function lineAtOffset(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split('\n').length;
}

function rebasePendingRegions(
  pending: readonly AuthorRegionDraft[],
  changed: AuthorRegionDraft,
  result: MutationResult,
  nextContent: string | undefined,
): readonly AuthorRegionDraft[] {
  return pending
    .filter((region) => region.id !== changed.id)
    .map((region) => {
      if (changed.anchor.kind !== 'text-range' || region.anchor.kind !== 'text-range' || nextContent === undefined)
        return { ...region, revision: result.revision };
      const delta = (result.after?.length ?? 0) - (result.before?.length ?? 0);
      const shift = region.anchor.startOffset >= changed.anchor.endOffset ? delta : 0;
      const startOffset = region.anchor.startOffset + shift;
      const endOffset = region.anchor.endOffset + shift;
      return {
        ...region,
        revision: result.revision,
        anchor: {
          ...region.anchor,
          startOffset,
          endOffset,
          startLine: lineAtOffset(nextContent, startOffset),
          endLine: lineAtOffset(nextContent, endOffset),
        },
      };
    });
}
function mutationTool(sessionId: string, path: string, kind: AuthorDocumentKind): AuthorTrustedTool | undefined {
  if (kind === 'pdf' || kind === 'video' || kind === 'opaque') return undefined;
  const needsReplacement = kind !== 'image';
  return {
    name: 'author_apply_region',
    label: 'Apply region change',
    description: 'Apply a fenced mutation through a previously resolved native Author region.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['regionId', 'expectedRevision', 'expectedSourceSha256', ...(needsReplacement ? ['replacement'] : [])],
      properties: {
        regionId: stringProperty,
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedSourceSha256: stringProperty,
        ...(needsReplacement ? { replacement: { type: 'string' } } : {}),
      },
    },
    execute: async (input, signal) => {
      const value = inputRecord(input);
      const regionId = requiredString(value, 'regionId');
      const request = authorSessionWorkspace(sessionId).requests.find(
        (candidate) =>
          (candidate.pendingRegions ?? candidate.regions).some((item) => item.id === regionId) &&
          candidate.status === 'REQUESTED',
      );
      if (request !== undefined) {
        updateAuthorRequest(sessionId, request.id, (current) => ({
          ...current,
          status: 'CHANGING',
          currentOperation: 'validating native anchor',
          updatedAt: Date.now(),
        }));
      }
      try {
        if (signal.aborted)
          throw signal.reason instanceof Error ? signal.reason : new Error('Author mutation cancelled.');
        const { document, region } = checkedRegion(sessionId, path, value);
        const pending = request?.pendingRegions ?? request?.regions ?? [region];
        assertRebasable(pending, region);
        if (request !== undefined) {
          updateAuthorRequest(sessionId, request.id, (current) => ({
            ...current,
            currentOperation: `mutating ${region.anchor.kind}`,
            updatedAt: Date.now(),
          }));
        }
        let result: MutationResult;
        let nextContent: string | undefined;
        if (region.anchor.kind === 'text-range') {
          const replacement = typeof value.replacement === 'string' ? value.replacement : '';
          const { startOffset, endOffset } = region.anchor;
          const content = document.content ?? '';
          const before = content.slice(startOffset, endOffset);
          nextContent = content.slice(0, startOffset) + replacement + content.slice(endOffset);
          reviseAuthorDocument(sessionId, path, nextContent);
          result = { changed: true, before, after: replacement, revision: document.version + 1 };
        } else if (region.anchor.kind === 'cell' || region.anchor.kind === 'slide-element') {
          const fragmentId = region.anchor.fragmentId;
          const fragment = document.fragments?.find((candidate) => candidate.id === fragmentId);
          if (fragment === undefined || fragment.readOnly === true)
            throw new Error('UNSUPPORTED_REGION: The native fragment is not editable.');
          const replacement = typeof value.replacement === 'string' ? value.replacement : '';
          reviseAuthorFragment(sessionId, path, fragment.id, replacement);
          result = { changed: true, before: fragment.text, after: replacement, revision: document.version + 1 };
        } else if (region.anchor.kind === 'image-rect') {
          setAuthorCrop(sessionId, path, region.anchor.rect);
          result = { changed: true, crop: region.anchor.rect, revision: document.version + 1 };
        } else {
          throw new Error('UNSUPPORTED_REGION: PDF and video regions are capture-only.');
        }
        if (request !== undefined) {
          const pendingRegions = rebasePendingRegions(pending, region, result, nextContent);
          updateAuthorRequest(sessionId, request.id, (current) => ({
            ...current,
            status: pendingRegions.length === 0 ? 'CHANGED' : 'REQUESTED',
            currentOperation: undefined,
            before: [current.before, result.before].filter((item) => item !== undefined).join('\n') || undefined,
            after:
              [current.after, result.after ?? (result.crop === undefined ? undefined : JSON.stringify(result.crop))]
                .filter((item) => item !== undefined)
                .join('\n') || undefined,
            pendingRegions,
            revision: result.revision,
            updatedAt: Date.now(),
          }));
        }
        return result;
      } catch (error) {
        if (request !== undefined) {
          updateAuthorRequest(sessionId, request.id, (current) => ({
            ...current,
            status: signal.aborted ? 'CANCELLED' : 'FAILED',
            currentOperation: undefined,
            error: signal.aborted
              ? 'Author mutation cancelled.'
              : error instanceof Error
                ? error.message
                : String(error),
            updatedAt: Date.now(),
          }));
        }
        throw error;
      }
    },
  };
}

export function authorGridTools(
  sessionId: string,
  path: string,
  kind: AuthorDocumentKind,
): readonly AuthorTrustedTool[] {
  const mutation = mutationTool(sessionId, path, kind);
  return [...gridTools(sessionId, path, kind), ...(mutation === undefined ? [] : [mutation])];
}
