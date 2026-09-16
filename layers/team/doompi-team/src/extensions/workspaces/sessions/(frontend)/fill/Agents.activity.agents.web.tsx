import { defineFill } from '@agimon-ai/doompi-core/web';

import { AgentsActivitySection } from './_components/AgentsActivitySection';

/**
 * Renders inside the `agents` activity group rather than after the groups.
 *
 * The target in the filename is the slot. `activity.agents` is the group this
 * package also declares, and the dock puts this in place of its one-line
 * footer summary.
 */
export default defineFill({ component: AgentsActivitySection });
