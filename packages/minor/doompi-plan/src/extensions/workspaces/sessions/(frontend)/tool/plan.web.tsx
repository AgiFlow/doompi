import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { claimsPlanReviewPrompt, PlanReviewPrompt } from '../../../../../web/components/PlanReviewPrompt';
import { PlanToolMessage } from '../../../../../web/components/PlanToolMessage';
import { PLAN_TOOL_NAMES } from '../../../../../web/lib/planToolRender';

export default defineToolRenderer({
  tools: [...PLAN_TOOL_NAMES],
  message: PlanToolMessage,
  prompt: { claims: claimsPlanReviewPrompt, component: PlanReviewPrompt },
});
