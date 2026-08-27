import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { askCallSummary, askResultView } from './askUserText.ts';

/** The answered list, or the outcome that stood in for it. */
function AskUserQuestionBody({ result, output, running, isError }: ToolMessageRenderProps) {
  if (running) {
    return (
      <MessageItemBody data-testid="tool-result-ask_user_question">
        {/* The questionnaire is below, where the input usually is; saying only
            "waiting" would leave the reader looking for it. */}
        <MessageItemStatus tone="running">answer below to continue</MessageItemStatus>
      </MessageItemBody>
    );
  }
  const view = askResultView(result?.details, output);
  if (view.kind === 'cancelled') {
    return (
      <MessageItemBody data-testid="tool-result-ask_user_question">
        <MessageItemStatus tone="running">cancelled</MessageItemStatus>
      </MessageItemBody>
    );
  }
  if (view.kind === 'voice') {
    return (
      <MessageItemBody data-testid="tool-result-ask_user_question">
        <pre className="whitespace-pre-wrap break-words text-doom-dim">{view.prompt}</pre>
      </MessageItemBody>
    );
  }
  if (view.kind === 'text') {
    return (
      <MessageItemBody data-testid="tool-result-ask_user_question">
        {view.text ? (
          <pre className={`whitespace-pre-wrap break-words ${isError ? 'text-doom-red' : 'text-doom-dim'}`}>
            {view.text}
          </pre>
        ) : (
          <MessageItemStatus tone={isError ? 'error' : 'ok'}>{isError ? 'failed' : 'submitted'}</MessageItemStatus>
        )}
      </MessageItemBody>
    );
  }
  return (
    <MessageItemBody data-testid="tool-result-ask_user_question">
      {view.answers.length === 0 ? (
        <MessageItemStatus tone="ok">submitted</MessageItemStatus>
      ) : (
        <ul className="flex flex-col gap-1">
          {view.answers.map((answer, index) => (
            <li key={`${String(index)}-${answer.question}`} className="break-words">
              <span className="text-doom-green">✓</span> <span className="text-doom-cyan">{answer.question}</span>:{' '}
              <span className="text-doom-dim">{answer.answer}</span>
            </li>
          ))}
        </ul>
      )}
    </MessageItemBody>
  );
}

/**
 * The ask_user_question tool's timeline item: "N question(s) (headers)" in
 * the header, the web half of the TUI renderCall, and the answered list or
 * the outcome that stood in for it in the body. The live questionnaire
 * arrives as an extension-UI dialog; this is the transcript record.
 */
export function AskUserQuestionToolMessage(props: ToolMessageRenderProps) {
  const summary = askCallSummary(props.args);
  return (
    <MessageItem tone={toolTone({ running: props.running, isError: props.isError })}>
      <MessageItemHeader title="ask_user_question">
        <span data-testid="tool-call-ask_user_question" className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-doom-hi">{summary.count}</span>
          {summary.headers ? <span className="min-w-0 truncate text-doom-faint">({summary.headers})</span> : null}
        </span>
      </MessageItemHeader>
      <AskUserQuestionBody {...props} />
    </MessageItem>
  );
}
