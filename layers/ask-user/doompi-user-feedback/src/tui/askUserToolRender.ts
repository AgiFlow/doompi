import { DoomToolCall, DoomToolResult, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { QuestionParams, QuestionParamsSchema } from '../schemas/questionnaire';
import type { QuestionnaireResult } from '../types/questionnaire';
export const askUserToolRender: Pick<
  ToolDefinition<typeof QuestionParamsSchema, QuestionnaireResult>,
  'renderCall' | 'renderResult'
> = {
  renderCall(args, theme) {
    const params = args as QuestionParams;
    const headers = params.questions.map((question) => question.header).join(', ');
    const count = `${params.questions.length} question${params.questions.length === 1 ? '' : 's'}`;
    const heading = renderToolHeading('ask', count, theme);
    return new DoomToolCall(headers ? `${heading} ${theme.fg('dim', `(${headers})`)}` : heading);
  },

  renderResult(result, _options, theme, context) {
    const details = result.details as QuestionnaireResult | undefined;
    if (!details) {
      const raw = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const color = context.isError ? 'error' : 'toolOutput';
      const fallback = context.isError ? '✗ failed' : '✓ submitted';
      return new DoomToolResult([theme.fg(color, raw || fallback)], theme, { wrap: true });
    }
    if (details.cancelled) {
      return new DoomToolResult([theme.fg('warning', '◐') + theme.fg('dim', ' cancelled')], theme);
    }
    if (details.delivery === 'voice' && details.voicePrompt) {
      return new DoomToolResult([theme.fg('toolOutput', details.voicePrompt)], theme, { wrap: true });
    }
    const lines = details.answers.map((answer) => {
      const scalar = answer.kind === 'multi' ? (answer.selected ?? []).join(', ') : answer.answer;
      return `${theme.fg('success', '✓')} ${theme.fg('accent', answer.question)}: ${theme.fg(
        'toolOutput',
        scalar ?? '',
      )}`;
    });
    if (lines.length === 0) lines.push(theme.fg('success', '✓') + theme.fg('dim', ' submitted'));
    return new DoomToolResult(lines, theme, { wrap: true });
  },
};
