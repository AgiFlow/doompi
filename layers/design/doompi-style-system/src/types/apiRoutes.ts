import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type {
  BuildStoryPreviewView,
  DisposeStoryPreviewView,
  ExportStoryPreviewImageView,
  StoryPreviewMetadataView,
} from './previewApi';

export default defineApiRoutes({
  metadata: {
    method: 'POST',
    path: '/metadata',
    response: apiResponse<StoryPreviewMetadataView>(),
  },
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
