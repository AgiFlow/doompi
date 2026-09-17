import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';
import { Hono } from 'hono';

import routes from '../../types/apiRoutes';
import type {
  BuildStoryPreviewRequest,
  DisposeStoryPreviewRequest,
  ExportStoryPreviewImageRequest,
} from '../../types/previewApi';
import { StoryPreviewService } from '../storyPreview';

export function createPreviewApi(workspaceRoot: string, previews = new StoryPreviewService(workspaceRoot)): Hono {
  const app = new Hono();

  app.post(routes.build.path, async (context) => {
    let request: BuildStoryPreviewRequest;
    try {
      request = (await context.req.json()) as BuildStoryPreviewRequest;
    } catch {
      return context.json({ error: 'The preview request body is not JSON.' }, 400);
    }
    if (
      typeof request.appPath !== 'string' ||
      typeof request.storyPath !== 'string' ||
      typeof request.storyExport !== 'string' ||
      (request.darkMode !== undefined && typeof request.darkMode !== 'boolean')
    ) {
      return context.json({ error: 'A preview requires appPath, storyPath, and an exact storyExport.' }, 400);
    }
    try {
      return context.json(await previews.build(request));
    } catch (reason) {
      return context.json(
        { error: reason instanceof Error ? reason.message : 'Unable to build the story preview.' },
        400,
      );
    }
  });

  app.post(routes.image.path, async (context) => {
    let request: ExportStoryPreviewImageRequest;
    try {
      request = (await context.req.json()) as ExportStoryPreviewImageRequest;
    } catch {
      return context.json({ error: 'The image request body is not JSON.' }, 400);
    }
    if (
      typeof request.appPath !== 'string' ||
      typeof request.storyPath !== 'string' ||
      typeof request.storyExport !== 'string'
    ) {
      return context.json({ error: 'An image export requires appPath, storyPath, and an exact storyExport.' }, 400);
    }
    try {
      return context.json(await previews.exportImage(request));
    } catch (reason) {
      return context.json(
        { error: reason instanceof Error ? reason.message : 'Unable to export the story image.' },
        400,
      );
    }
  });

  app.delete(routes.dispose.path, async (context) => {
    let request: DisposeStoryPreviewRequest;
    try {
      request = (await context.req.json()) as DisposeStoryPreviewRequest;
    } catch {
      return context.json({ error: 'The dispose request body is not JSON.' }, 400);
    }
    if (typeof request.handle !== 'string') return context.json({ error: 'A preview handle is required.' }, 400);
    return context.json({ disposed: await previews.dispose(request.handle) });
  });

  return app;
}

export const api: DoomApi = {
  basePath: 'style-system-preview',
  start(context: DoomApiContext): DoomApiHandler {
    if (context.workspaceRoot === undefined)
      throw new Error('Style-system preview requires a workspace-scoped session.');
    const service = new StoryPreviewService(context.workspaceRoot);
    const previews = createPreviewApi(context.workspaceRoot, service);
    return { fetch: (request) => previews.fetch(request), close: () => service.disposeAll() };
  },
};
