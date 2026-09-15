import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { OpenAuthoringFileToolCard } from '../../../../../web/components/OpenAuthoringFileToolCard';

export default defineToolRenderer({ tools: ['open_authoring_file'], message: OpenAuthoringFileToolCard });
