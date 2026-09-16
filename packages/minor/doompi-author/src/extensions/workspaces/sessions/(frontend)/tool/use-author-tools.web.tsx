import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { UseAuthorToolsToolCard } from './_components/UseAuthorToolsToolCard';

export default defineToolRenderer({ tools: ['use_author_tools'], message: UseAuthorToolsToolCard });
