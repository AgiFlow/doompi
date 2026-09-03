import {
  Button,
  handleOptionListKey,
  Kbd,
  OptionList,
  optionListHint,
  SectionLabel,
} from '@agimon-ai/doompi-web-components';
import type { ToolPromptDialog, ToolPromptRenderProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useRef, useState } from 'react';
import { PLAN_REVIEW_OPTIONS, PLAN_REVIEW_TITLE } from '../types/planApi.ts';

/** Claims only the selector opened by complete_plan, leaving unrelated extension dialogs alone. */
export function claimsPlanReviewPrompt(dialog: ToolPromptDialog): boolean {
  return (
    dialog.method === 'select' &&
    dialog.title === PLAN_REVIEW_TITLE &&
    dialog.options.length === PLAN_REVIEW_OPTIONS.length &&
    PLAN_REVIEW_OPTIONS.every((option, index) => dialog.options[index] === option)
  );
}

/** Keeps plan approval in the composer so the conversation remains visible while the user decides. */
export function PlanReviewPrompt({ dialog, answer, cancel }: ToolPromptRenderProps) {
  const [cursor, setCursor] = useState(0);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => frame.current?.focus(), [dialog.id]);

  return (
    <div
      ref={frame}
      role="group"
      tabIndex={-1}
      data-testid="plan-review-prompt"
      className="flex min-w-0 flex-col overflow-hidden outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        handleOptionListKey(event, {
          options: dialog.options,
          cursor,
          onCursorChange: setCursor,
          onSelect: answer,
        });
      }}
    >
      <div className="flex flex-col gap-1 px-3.5 pt-3 pb-2">
        <SectionLabel>plan review</SectionLabel>
        <p className="text-[13px] leading-relaxed text-doom-hi">{dialog.title}</p>
        <p className="text-[11px] leading-relaxed text-doom-dim">
          Review the plan in the conversation before choosing what happens next.
        </p>
      </div>

      <OptionList
        options={dialog.options}
        cursor={cursor}
        onCursorChange={setCursor}
        onSelect={answer}
        testIdPrefix="plan-review-option"
        className="max-h-48 px-3.5 pb-3"
      />

      <div className="flex min-h-[34px] items-center gap-2 border-t border-doom-border-soft px-3.5 py-2">
        <span className="text-[10px] text-doom-faint">
          {optionListHint(dialog.options.length)} · <Kbd>esc</Kbd> cancels
        </span>
        <Button variant="outline" size="sm" data-testid="plan-review-cancel" className="ml-auto" onClick={cancel}>
          cancel
        </Button>
      </div>
    </div>
  );
}
