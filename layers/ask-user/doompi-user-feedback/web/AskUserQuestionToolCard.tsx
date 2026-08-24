import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { askCallSummary, askResultView } from './askUserText.ts';

/** The web half of the TUI renderCall: "N question(s) (headers)". */
export function AskUserQuestionCall({ args }: ToolCallRenderProps) {
  const summary = askCallSummary(args);
  return (
    <span data-testid="tool-call-ask_user_question" className="flex min-w-0 items-center gap-2">
      <span className="text-doom-hi">{summary.count}</span>
      {summary.headers ? <span className="min-w-0 truncate text-doom-faint">({summary.headers})</span> : null}
    </span>
  );
}

/** The web half of the TUI renderResult: the answered list, or the outcome that stood in for it. */
export function AskUserQuestionResult({ result, output, isPartial, isError }: ToolResultRenderProps) {
  if (isPartial) {
    return (
      <div data-testid="tool-result-ask_user_question" className="text-doom-faint">
        <span className="text-doom-yellow">◐</span> waiting for the user
      </div>
    );
  }
  const view = askResultView(result?.details, output);
  if (view.kind === 'cancelled') {
    return (
      <div data-testid="tool-result-ask_user_question" className="text-doom-faint">
        <span className="text-doom-yellow">◐</span> cancelled
      </div>
    );
  }
  if (view.kind === 'voice') {
    return (
      <pre data-testid="tool-result-ask_user_question" className="whitespace-pre-wrap break-words text-doom-dim">
        {view.prompt}
      </pre>
    );
  }
  if (view.kind === 'text') {
    const fallback = isError ? '✗ failed' : '✓ submitted';
    return (
      <pre
        data-testid="tool-result-ask_user_question"
        className={`whitespace-pre-wrap break-words ${isError ? 'text-doom-red' : 'text-doom-dim'}`}
      >
        {view.text || fallback}
      </pre>
    );
  }
  return (
    <ul data-testid="tool-result-ask_user_question" className="flex flex-col gap-1">
      {view.answers.length === 0 ? (
        <li className="text-doom-faint">
          <span className="text-doom-green">✓</span> submitted
        </li>
      ) : (
        view.answers.map((answer, index) => (
          <li key={`${index}-${answer.question}`} className="break-words">
            <span className="text-doom-green">✓</span> <span className="text-doom-cyan">{answer.question}</span>:{' '}
            <span className="text-doom-dim">{answer.answer}</span>
          </li>
        ))
      )}
    </ul>
  );
}
