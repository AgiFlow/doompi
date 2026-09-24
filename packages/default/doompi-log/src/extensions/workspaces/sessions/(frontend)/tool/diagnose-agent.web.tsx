import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { AgentDiagnosticCard } from './_components/AgentDiagnosticCard';

export default defineToolRenderer({ tools: ['diagnose_agent'], message: AgentDiagnosticCard });
