import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { HelpStatusCard } from './_components/HelpStatusCard';

export default defineToolRenderer({ tools: ['help_status', 'diagnose_setup'], message: HelpStatusCard });
