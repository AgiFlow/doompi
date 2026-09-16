import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { claimsPlanReviewPrompt, PlanReviewPrompt } from './_components/PlanReviewPrompt';
import { PlanToolMessage } from './_components/PlanToolMessage';
import { PLAN_TOOL_NAMES } from './_lib/planToolRender';

export default defineToolRenderer({
  tools: [...PLAN_TOOL_NAMES],
  message: PlanToolMessage,
  prompt: { claims: claimsPlanReviewPrompt, component: PlanReviewPrompt },
});
