import { api } from '../../../../../../generated/client';
import type {
  BuildStoryPreviewRequest,
  BuildStoryPreviewView,
  ExportStoryPreviewImageView,
} from '../../../../../types/previewApi';

function errorMessage(result: { status: number; error: string }): string {
  if (result.status === 0) return 'The preview service is unreachable.';
  return result.error === '' ? `The preview service answered ${String(result.status)}.` : result.error;
}

export async function buildPreview(
  sessionId: string,
  request: BuildStoryPreviewRequest,
): Promise<{ ok: true; preview: BuildStoryPreviewView } | { ok: false; error: string }> {
  const result = await api.session(sessionId).build({ body: request });
  return result.ok ? { ok: true, preview: result.data } : { ok: false, error: errorMessage(result) };
}

export async function exportPreviewImage(
  sessionId: string,
  request: BuildStoryPreviewRequest,
): Promise<{ ok: true; image: ExportStoryPreviewImageView } | { ok: false; error: string }> {
  const result = await api.session(sessionId).image({ body: request });
  return result.ok ? { ok: true, image: result.data } : { ok: false, error: errorMessage(result) };
}

export async function disposePreview(sessionId: string, handle: string): Promise<void> {
  await api.session(sessionId).dispose({ body: { handle } });
}
