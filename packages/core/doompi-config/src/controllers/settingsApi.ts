import type { DoomApi } from '@agimon-ai/doompi-core/package-api';
import { KEY_SEPARATOR } from '../constants/settings';
import { repositoryDoomConfigPath } from '../services/config';
import { configScopeOf } from '../services/configPolicy';
import { setDoomConfigValue, unsetDoomConfigValue, writeDoomConfigValues } from '../services/configWriter';
import { DEFAULT_IMAGE_MAX_DIMENSION, MIN_IMAGE_MAX_DIMENSION } from '../services/imageSettings';
import { loadPiImageSettings, savePiImageSettings } from '../services/piConfig';
import type { SettingsRepository } from '../types/settings';

import {
  configView,
  describe,
  isRecord,
  parseSelectionWrite,
  parseWrite,
  pathFor,
  repositorySettingsView,
  selectionEdits,
  validateSelectionChanges,
} from '../services/settings';

/** Config handlers are bound to their mount. Request paths cannot choose a different repository. */
export const settingsApi: DoomApi = {
  basePath: 'config',
  start(context) {
    if (context.scope === 'session') throw new Error('Configuration settings require a global or workspace mount.');
    const { homeDirectory } = context;
    const repository = (): SettingsRepository | undefined =>
      context.scope === 'workspace' && context.workspaceId && context.workspaceRoot
        ? {
            id: context.workspaceId,
            name: context.workspaceRoot.split('/').at(-1) ?? context.workspaceId,
            path: context.workspaceRoot,
            active: context.repositories?.().find((entry) => entry.id === context.workspaceId)?.active ?? false,
          }
        : undefined;
    const imageView = () => ({
      ...loadPiImageSettings(homeDirectory),
      minDimension: MIN_IMAGE_MAX_DIMENSION,
      maxAllowedDimension: DEFAULT_IMAGE_MAX_DIMENSION,
    });
    let writes: Promise<unknown> = Promise.resolve();
    let closed = false;
    const dispatch = async (request: Request): Promise<Response> => {
      if (closed) return Response.json({ error: 'Configuration mount is closed.' }, { status: 503 });
      const url = new URL(request.url);
      const currentRepository = repository();
      if (url.pathname === '/config' && request.method === 'GET')
        return Response.json(configView(context, url.searchParams.getAll('key')));
      if (url.pathname === '/repositories' && request.method === 'GET')
        return Response.json({ repositories: context.repositories?.() ?? [] });
      if (url.pathname === '/repository' && request.method === 'GET') {
        return currentRepository
          ? Response.json(repositorySettingsView(currentRepository, homeDirectory))
          : Response.json({ error: 'Choose a workspace.' }, { status: 404 });
      }
      if (url.pathname === '/images' && context.scope === 'global') {
        if (request.method === 'GET') return Response.json(imageView());
        if (request.method === 'PUT') {
          const body: unknown = await request.json();
          if (
            !isRecord(body) ||
            (body.autoResize !== undefined && typeof body.autoResize !== 'boolean') ||
            (body.maxDimension !== undefined &&
              (typeof body.maxDimension !== 'number' || !Number.isFinite(body.maxDimension)))
          )
            return Response.json({ error: 'Invalid image settings.' }, { status: 400 });
          savePiImageSettings(
            {
              ...(typeof body.autoResize === 'boolean' ? { autoResize: body.autoResize } : {}),
              ...(typeof body.maxDimension === 'number' ? { maxDimension: body.maxDimension } : {}),
            },
            homeDirectory,
          );
          context.configurationChanged?.();
          return Response.json(imageView());
        }
      }
      if (url.pathname === '/repository/selection' && request.method === 'PUT') {
        const body = parseSelectionWrite(await request.json());
        if (!body)
          return Response.json({ error: 'A selection write needs typed changes and a file hash.' }, { status: 400 });
        if (!currentRepository || body.repositoryId !== currentRepository.id)
          return Response.json({ error: 'Workspace not found in this mount.' }, { status: 404 });
        const before = repositorySettingsView(currentRepository, homeDirectory);
        if (before.hash !== body.expectedHash)
          return Response.json(
            { error: 'The repository config changed since it was read.', hash: before.hash },
            { status: 409 },
          );
        const invalid = validateSelectionChanges(before, body.changes);
        if (invalid) return Response.json({ error: invalid }, { status: 422 });
        await writeDoomConfigValues(repositoryDoomConfigPath(currentRepository.path), selectionEdits(body.changes), {
          scope: 'repository',
        });
        context.configurationChanged?.();
        return Response.json(repositorySettingsView(currentRepository, homeDirectory));
      }
      if (url.pathname === '/value' && request.method === 'PUT') {
        const body = parseWrite(await request.json());
        if (!body)
          return Response.json({ error: 'A save requires a scope, key, value and file hash.' }, { status: 400 });
        const scope = context.scope === 'global' ? 'global' : 'repository';
        if (body.scope !== scope || (scope === 'repository' && body.repoRoot !== currentRepository?.path))
          return Response.json({ error: 'The write targets a different mount.' }, { status: 403 });
        const allowed = configScopeOf(body.keyPath);
        if (allowed !== 'both' && allowed !== scope)
          return Response.json({ error: 'This key cannot be set at this scope.' }, { status: 409 });
        const before = configView(context, []);
        if (before.hashes[scope] !== body.expectedHash)
          return Response.json(
            { error: 'The config changed since it was read.', hash: before.hashes[scope] },
            { status: 409 },
          );
        const target = pathFor(scope, currentRepository?.path ?? '', homeDirectory);
        if (body.value === null) await unsetDoomConfigValue(target, body.keyPath, { scope });
        else await setDoomConfigValue(target, body.keyPath, body.value, { scope });
        context.configurationChanged?.();
        return Response.json(configView(context, [body.keyPath.join(KEY_SEPARATOR)]));
      }
      return Response.json({ error: 'Configuration route not found.' }, { status: 404 });
    };
    const guarded = async (request: Request): Promise<Response> => {
      try {
        return await dispatch(request);
      } catch (error) {
        return Response.json({ error: describe(error) }, { status: error instanceof SyntaxError ? 400 : 422 });
      }
    };
    return {
      fetch(request) {
        if (request.method === 'GET' || request.method === 'HEAD') return guarded(request);
        const result = writes.then(() => guarded(request));
        writes = result.catch(() => undefined);
        return result;
      },
      close() {
        closed = true;
      },
    };
  },
};
