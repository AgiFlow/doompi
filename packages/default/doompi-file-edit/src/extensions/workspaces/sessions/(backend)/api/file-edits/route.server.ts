import { defineRoute } from '@agimon-ai/doompi-core/extensionFile';

import { api } from '../../../../../../services/fileEditsApi';

/**
 * Mounts this package's HTTP API at `file-edits`, which the folder names.
 *
 * Until this file existed the API was never mounted at all. The session root
 * returns a runtime carrying `api`, but a root's `api` is not folded into the
 * generated entry the way its services and activities are, so the registration
 * was dropped in silence and the cockpit called routes that answered 404.
 */
export default defineRoute(api);
