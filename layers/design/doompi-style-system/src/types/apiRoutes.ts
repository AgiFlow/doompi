import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type { BuildStoryPreviewView, DisposeStoryPreviewView, ExportStoryPreviewImageView } from './previewApi';

export default defineApiRoutes({
  build: {
    method: 'POST',
    path: '/build',
    response: apiResponse<BuildStoryPreviewView>(),
  },
  image: {
    method: 'POST',
    path: '/image',
    response: apiResponse<ExportStoryPreviewImageView>(),
  },
  dispose: {
    method: 'DELETE',
    path: '/artifact',
    response: apiResponse<DisposeStoryPreviewView>(),
  },
});
