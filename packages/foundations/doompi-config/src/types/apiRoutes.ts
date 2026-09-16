import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import { KEY_QUERY_PARAM } from '../constants/settings';
import type { RepositorySettingsView, SettingsConfigView, SettingsImagesView, SettingsRepository } from './settings';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/(backend)/api/settings/`, so the mount is stated once, by the
 * folder that creates it. `settings` is the host's own API: it answers at
 * `/api/settings` and `/api/workspaces/<id>/settings`, beside `/plugins` rather
 * than under it, and the client knows that from the base path alone.
 *
 * This is the one file the mount's dispatcher and, once the client crosses the
 * package boundary, the cockpit both read, so a path cannot move on one side
 * alone.
 */
export default defineApiRoutes({
  /** The mount itself: the selected keys and the hash of each file they came from. */
  config: {
    method: 'GET',
    path: '/',
    /** Repeatable. The page also sends `repoRoot`, which the mount ignores: it serves one repository. */
    query: [KEY_QUERY_PARAM],
    response: apiResponse<SettingsConfigView>(),
  },
  value: {
    method: 'PUT',
    path: '/value',
    response: apiResponse<SettingsConfigView>(),
  },
  repositories: {
    method: 'GET',
    path: '/repositories',
    response: apiResponse<{ repositories: readonly SettingsRepository[] }>(),
  },
  /** The workspace this mount was bound to; a global mount has none and answers 404. */
  repository: {
    method: 'GET',
    path: '/repository',
    response: apiResponse<RepositorySettingsView>(),
  },
  selection: {
    method: 'PUT',
    path: '/repository/selection',
    response: apiResponse<RepositorySettingsView>(),
  },
  /** Pi's own image limits, served by the global mount only. */
  images: {
    method: 'GET',
    path: '/images',
    response: apiResponse<SettingsImagesView>(),
  },
  /** The same path as `images`; the method is the whole of the difference. */
  saveImages: {
    method: 'PUT',
    path: '/images',
    response: apiResponse<SettingsImagesView>(),
  },
});
