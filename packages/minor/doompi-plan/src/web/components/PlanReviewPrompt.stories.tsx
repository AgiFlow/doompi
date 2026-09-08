/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * `ToolPromptRenderProps` is the tool-message contract plus the open request,
 * so the message half comes from the contracts package's own fixture and only
 * the dialog is written out here; the options come from the shared contract.
 */
import type { ToolPromptRenderProps } from '@agimon-ai/doompi-web-contracts';
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { PlanReviewPrompt } from './PlanReviewPrompt.tsx';
import { PLAN_REVIEW_OPTIONS, PLAN_REVIEW_TITLE } from '../../types/planApi.ts';

const noop = (): void => undefined;

const promptProps = (id: string): ToolPromptRenderProps => ({
  ...toolMessagePropsFixture({ toolName: 'complete_plan', running: true }).props,
  dialog: {
    id,
    method: 'select',
    title: PLAN_REVIEW_TITLE,
    message: '',
    options: PLAN_REVIEW_OPTIONS,
    placeholder: '',
    prefill: '',
  },
  answer: noop,
  cancel: noop,
});

const meta = {
  title: 'Plan/PlanReviewPrompt',
  component: PlanReviewPrompt,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">awaiting the review decision</span>
        <div className="rounded-md border border-doom-border bg-doom-panel">
          <PlanReviewPrompt {...promptProps('prompt-1')} />
        </div>
      </div>
    </div>
  ),
};
