import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { LoopToolCard } from './_components/LoopToolCard';

export default defineToolRenderer({ tools: ['loop_list'], message: LoopToolCard });
