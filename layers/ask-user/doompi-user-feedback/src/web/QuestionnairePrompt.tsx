import {
  Badge,
  Button,
  Kbd,
  Markdown,
  OptionLabel,
  OptionRow,
  SectionLabel,
  Separator,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import type { ToolPromptRenderProps } from '@agimon-ai/doompi-web-contracts';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { encodeAnswerEnvelope } from '../types/askUserWire.ts';
import {
  chooseOption,
  CUSTOM_LABEL,
  draftAnswers,
  draftEntry,
  emptyDraft,
  isAnswered,
  isComplete,
  nextUnanswered,
  type PromptQuestion,
  type QuestionnaireDraft,
  readPromptQuestions,
  setCustom,
  setNotes,
} from './questionnaireDraft.ts';

/** The step bar: which questions are answered, which one is open, and a click back to any of them. */
function StepBar({
  questions,
  draft,
  current,
  onPick,
}: {
  questions: readonly PromptQuestion[];
  draft: QuestionnaireDraft;
  current: number;
  onPick: (index: number) => void;
}) {
  return (
    <div data-testid="questionnaire-steps" className="flex min-w-0 flex-wrap items-center gap-1.5">
      {questions.map((question, index) => {
        const answered = isAnswered(draftEntry(draft, index));
        const active = index === current;
        return (
          <Button
            key={question.question}
            variant="ghost"
            size="xs"
            data-testid={`questionnaire-step-${String(index)}`}
            data-step-state={active ? 'current' : answered ? 'answered' : 'pending'}
            onClick={() => onPick(index)}
            className={`gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] ${
              active
                ? 'bg-doom-selected text-doom-on-selected'
                : answered
                  ? 'text-doom-green hover:bg-doom-panel'
                  : 'text-doom-faint hover:bg-doom-panel'
            }`}
          >
            <span aria-hidden>{answered ? '✓' : '○'}</span>
            {question.header || `question ${String(index + 1)}`}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The frame's shortcuts stop at a text field: while the caret is in one the
 * arrows and Enter belong to the field, so they are kept from bubbling. Enter
 * commits the field the way the terminal editor does, Shift+Enter writes a
 * newline, and Escape and Cmd/Ctrl+Enter still reach the frame.
 */
function fieldKeys(commit: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return;
    event.stopPropagation();
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    commit();
  };
}

/** One question's options, its typed-answer row, and the preview of whatever is focused. */
function QuestionBody({
  question,
  index,
  draft,
  cursor,
  onCursor,
  onDraft,
  onCommit,
}: {
  question: PromptQuestion;
  index: number;
  draft: QuestionnaireDraft;
  cursor: number;
  onCursor: (cursor: number) => void;
  /** `settles` is true only for an edit that finishes the question, which is what may move on. */
  onDraft: (draft: QuestionnaireDraft, settles: boolean) => void;
  /** Enter in a text field: hands the keyboard back to the frame, settling the question or not. */
  onCommit: (settles: boolean) => void;
}) {
  const entry = draftEntry(draft, index);
  const typing = entry.custom !== null;
  const preview = question.options[cursor]?.preview;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p data-testid="questionnaire-question" className="break-words text-[13px] leading-relaxed text-doom-hi">
        {question.question}
      </p>

      <div role="listbox" aria-label="options" className="flex min-w-0 flex-col">
        {question.options.map((option, optionIndex) => {
          const chosen = entry.selected.includes(option.label);
          return (
            <OptionRow
              key={option.label}
              active={optionIndex === cursor && !typing}
              data-testid={`questionnaire-option-${String(optionIndex)}`}
              data-chosen={chosen}
              onMouseEnter={() => onCursor(optionIndex)}
              // A multiSelect question is not finished by one click: moving on
              // there would take the list away before a second option could be
              // picked, which is the whole point of the question.
              onClick={() =>
                onDraft(chooseOption(draft, index, option.label, question.multiSelect), !question.multiSelect)
              }
              className="min-w-0 items-start gap-2.5 rounded-md px-2.5 py-1.5 whitespace-normal"
            >
              <span className={`mt-[2px] shrink-0 text-[11px] ${chosen ? 'text-doom-green' : 'text-doom-faint'}`}>
                {question.multiSelect ? (chosen ? '[x]' : '[ ]') : chosen ? '●' : '○'}
              </span>
              <OptionLabel className="min-w-0 flex flex-col gap-0.5 text-left">
                <span className={`break-words text-[12px] ${chosen ? 'text-doom-hi' : 'text-doom-text'}`}>
                  {option.label}
                </span>
                {option.description ? (
                  <span className="break-words text-[11px] leading-relaxed whitespace-normal text-doom-dim">
                    {option.description}
                  </span>
                ) : null}
              </OptionLabel>
            </OptionRow>
          );
        })}

        <OptionRow
          active={typing}
          data-testid="questionnaire-option-custom"
          onClick={() => onDraft(setCustom(draft, index, entry.custom ?? ''), false)}
          className="min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 whitespace-normal"
        >
          <span className="shrink-0 text-[11px] text-doom-faint">✎</span>
          <OptionLabel className="min-w-0 text-[12px] whitespace-normal text-doom-text">{CUSTOM_LABEL}</OptionLabel>
        </OptionRow>
      </div>

      {typing ? (
        <div className="flex flex-col gap-1">
          <SectionLabel>your answer</SectionLabel>
          <Textarea
            data-testid="questionnaire-custom"
            autoFocus
            rows={2}
            value={entry.custom ?? ''}
            placeholder="type your answer…"
            onChange={(event) => onDraft(setCustom(draft, index, event.target.value), false)}
            onKeyDown={fieldKeys(() => onCommit(true))}
            className="text-[12px]"
          />
        </div>
      ) : null}

      {preview ? (
        <div data-testid="questionnaire-preview" className="flex flex-col gap-1">
          <SectionLabel>preview</SectionLabel>
          <div className="max-h-40 overflow-y-auto border-l-2 border-doom-edge-magenta pl-3 text-[11px] text-doom-dim">
            <Markdown text={preview} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <SectionLabel>note (optional)</SectionLabel>
        <Textarea
          data-testid="questionnaire-notes"
          rows={1}
          value={entry.notes}
          placeholder="anything the options do not cover"
          onChange={(event) => onDraft(setNotes(draft, index, event.target.value), false)}
          onKeyDown={fieldKeys(() => onCommit(false))}
          className="text-[11px]"
        />
      </div>
    </div>
  );
}

/**
 * The questionnaire, standing in for the composer input while the agent waits.
 *
 * Every question is here at once, because the cockpit can see the whole call
 * even though the request it answers can only carry one question's labels.
 * That is what makes the step bar honest: nothing is sent until the reader
 * submits, so going back to a step is just moving a cursor, and the agent is
 * asked exactly once.
 */
export function QuestionnairePrompt({ args, dialog, answer, cancel }: ToolPromptRenderProps) {
  const questions = useMemo(() => readPromptQuestions(args), [args]);
  const [draft, setDraft] = useState<QuestionnaireDraft>(() => emptyDraft(questions.length));
  const [current, setCurrent] = useState(0);
  const [cursor, setCursor] = useState(0);
  const frame = useRef<HTMLDivElement>(null);

  // A new request is a new questionnaire; nothing from the last one carries over.
  useEffect(() => {
    // Remounting on dialog.id would be the alternative, but the prompt host owns the
    // element, so the reset lives here.
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft(emptyDraft(questions.length));
    setCurrent(0);
    setCursor(0);
  }, [dialog.id, questions.length]);

  // The agent is blocked on this, so it takes the keyboard the input had.
  useEffect(() => frame.current?.focus(), [dialog.id]);

  const question = questions[current];
  const complete = isComplete(draft);

  const move = (next: QuestionnaireDraft, answeredIndex: number, settles: boolean): void => {
    setDraft(next);
    // Follow the reader forwards the way the terminal does, but only on an
    // edit that finished the question, and only while something is still
    // unanswered: jumping after the last answer would take the step they just
    // finished off the screen before they could look at it.
    if (!settles) return;
    const pending = nextUnanswered(next, answeredIndex);
    if (pending >= 0 && pending !== answeredIndex) {
      setCurrent(pending);
      setCursor(0);
    }
  };

  const show = (index: number): void => {
    setCurrent(index);
    setCursor(0);
  };

  const submit = (): void => {
    if (!complete) return;
    answer(encodeAnswerEnvelope(draftAnswers(questions, draft)));
  };

  if (question === undefined) {
    return (
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <span data-testid="questionnaire-empty" className="text-[12px] text-doom-dim">
          the agent asked something this cockpit could not read
        </span>
        <Button variant="outline" size="sm" data-testid="questionnaire-cancel" onClick={cancel}>
          cancel
        </Button>
      </div>
    );
  }

  const typing = draftEntry(draft, current).custom !== null;
  return (
    // The keys belong to the frame rather than to any row, so the reader can
    // move between questions and options without tabbing through both.
    <div
      ref={frame}
      tabIndex={-1}
      data-testid="questionnaire"
      className="flex min-w-0 flex-col overflow-hidden outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
          return;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
          return;
        }
        // While typing an answer the arrows belong to the textarea.
        if (typing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const count = question.options.length;
          setCursor((event.key === 'ArrowDown' ? cursor + 1 : cursor - 1 + count) % count);
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const count = questions.length;
          show((event.key === 'ArrowRight' ? current + 1 : current - 1 + count) % count);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const option = question.options[cursor];
          if (option === undefined) {
            submit();
            return;
          }
          move(chooseOption(draft, current, option.label, question.multiSelect), current, !question.multiSelect);
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pt-2.5 pb-2 sm:gap-3 sm:px-3.5">
        <StepBar questions={questions} draft={draft} current={current} onPick={show} />
        <span className="min-w-0 flex-1" />
        <Badge size="xs" className="shrink-0 border-transparent bg-doom-panel py-0.5 text-[9px] text-doom-dim">
          question {current + 1} / {questions.length}
        </Badge>
      </div>

      <Separator />

      <div className="max-h-[46vh] min-w-0 overflow-x-hidden overflow-y-auto px-3 py-3 sm:px-3.5">
        <QuestionBody
          question={question}
          index={current}
          draft={draft}
          cursor={cursor}
          onCursor={setCursor}
          onDraft={(next, settles) => move(next, current, settles)}
          onCommit={(settles) => {
            frame.current?.focus();
            move(draft, current, settles);
          }}
        />
      </div>

      <Separator />

      <div className="flex min-w-0 items-center gap-2 px-3 py-2 sm:px-3.5">
        <span data-testid="questionnaire-hint" className="min-w-0 truncate text-[10px] text-doom-faint max-sm:hidden">
          <Kbd>←→</Kbd> questions · <Kbd>↑↓</Kbd> options · <Kbd>enter</Kbd>{' '}
          {question.multiSelect ? 'toggles' : 'selects'} · <Kbd>esc</Kbd> cancels
        </span>
        <span className="flex-1" />
        <Button variant="outline" size="md" data-testid="questionnaire-cancel" onClick={cancel}>
          cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          data-testid="questionnaire-submit"
          onClick={submit}
          disabled={!complete}
          title={complete ? 'send every answer to the agent' : 'answer every question first'}
          className="shrink-0 px-3 max-sm:max-w-32 max-sm:truncate sm:px-3.5"
        >
          submit answers
        </Button>
      </div>
    </div>
  );
}
