import { renderPlugin, toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { ToolPromptDialog } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTINUE_PLANNING_CHOICE,
  EXIT_PLAN_MODE_CHOICE,
  PLAN_REVIEW_OPTIONS,
  PLAN_REVIEW_TITLE,
} from '../../src/types/planApi.ts';
import { claimsPlanReviewPrompt, PlanReviewPrompt } from '../../src/web/PlanReviewPrompt.tsx';
import { webPlugin } from '../../src/web/index.ts';

function dialog(patch: Partial<ToolPromptDialog> = {}): ToolPromptDialog {
  return {
    id: 'plan-review-1',
    method: 'select',
    title: PLAN_REVIEW_TITLE,
    message: '',
    options: PLAN_REVIEW_OPTIONS,
    placeholder: '',
    prefill: '',
    ...patch,
  };
}

describe('the plan review composer prompt', () => {
  it('claims only the selector opened by complete_plan', () => {
    expect(claimsPlanReviewPrompt(dialog())).toBe(true);
    expect(claimsPlanReviewPrompt(dialog({ title: 'Another question' }))).toBe(false);
    expect(claimsPlanReviewPrompt(dialog({ method: 'confirm' }))).toBe(false);
    expect(claimsPlanReviewPrompt(dialog({ options: ['Continue planning', 'Exit'] }))).toBe(false);
  });

  it('renders both decisions where the chat composer normally sits', () => {
    const rendered = renderPlugin(PlanReviewPrompt, {
      ...toolMessagePropsFixture({ toolName: 'complete_plan', running: true }).props,
      dialog: dialog(),
      answer: vi.fn(),
      cancel: vi.fn(),
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="plan-review-prompt"');
    expect(rendered.includes(EXIT_PLAN_MODE_CHOICE)).toBe(true);
    expect(rendered.includes(CONTINUE_PLANNING_CHOICE)).toBe(true);
    expect(rendered.includes('Review the plan in the conversation')).toBe(true);
  });

  it('registers the composer prompt on the complete_plan renderer', () => {
    const renderer = webPlugin.toolRenderers?.find((entry) => entry.tools.includes('complete_plan'));

    expect(renderer?.prompt?.component).toBe(PlanReviewPrompt);
    expect(renderer?.prompt?.claims?.(dialog(), {})).toBe(true);
  });
});
