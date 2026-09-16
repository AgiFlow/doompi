import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type { FileEditsDetailView, FileEditsPreviewView, FileEditsSaveView } from './fileEditsApi';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/workspaces/sessions/(backend)/api/file-edits/`, so the mount
 * is stated once, by the folder that creates it. They used to be written here,
 * in the contract and again inside every URL the page built, and the copies
 * were free to disagree.
 *
 * This is the one file the routes, the Hono app and the browser all read, so a
 * path cannot move on one side alone.
 */
export default defineApiRoutes({
  detail: {
    method: 'GET',
    path: '/detail',
    query: ['path'],
    response: apiResponse<FileEditsDetailView>(),
  },
  preview: {
    method: 'GET',
    path: '/preview',
    query: ['path'],
    response: apiResponse<FileEditsPreviewView>(),
  },
  save: {
    method: 'PUT',
    path: '/content',
    response: apiResponse<FileEditsSaveView>(),
  },
  /** The same path as `save`; the method is the whole of the difference. */
  remove: {
    method: 'DELETE',
    path: '/content',
    query: ['path'],
  },
  /**
   * The host's own bytes route, not this package's.
   *
   * `host: true` hangs it off the session root rather than under `/plugins`,
   * which is how the cockpit already serves it. Declaring it here is the first
   * time anything records that this package's previews depend on it.
   */
  file: {
    method: 'GET',
    path: '/file',
    query: ['path'],
    host: true,
  },
});
