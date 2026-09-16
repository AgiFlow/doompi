import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { voiceReadinessApi } from '../../../../services/voiceReadinessApi';

/**
 * The global half of the `voice` mount: readiness, and nothing else.
 *
 * The folder is named for the base path the service registers, not for the one
 * route it serves. It was called `voice-readiness/` while `voiceReadinessApi`
 * mounted at `voice`, which cost nothing while every URL was hand-built and
 * became a wrong base path the moment the build started reading the mount off
 * the folder. `workspaces/sessions/(backend)/api/voice/` names the same mount
 * at session scope, and that is not a collision: one base path, two scopes, the
 * host resolving which handler answers, exactly as the contract declares it.
 *
 * Only global. A facet offers a contribution at every scope below its own, so
 * the guard is what keeps readiness off workspace and session, where the
 * session tree's status and control routes answer instead.
 */
export default defineRoutedContribution(
  ({ host }: DoomServerPluginContext) => (host.scope === 'global' ? voiceReadinessApi : undefined),
  { cardinality: 'optional' },
);
