import type { MinorModeCatalogService } from '@agimon-ai/doompi-extension-contracts/mode';
import { createNarrationRequest, type DoomNarrationService } from '@agimon-ai/doompi-extension-contracts/narration';
import type { QuestionParams } from '../../schemas/questionnaire.js';
import { isAutonomousVoiceRecord } from '../../services/autonomousVoiceMode.js';
import { buildVoiceQuestionNarration } from '../../services/voiceQuestionNarration.js';
import type { QuestionnaireResult, ToolTextResult } from '../../types/questionnaire.js';

export const VOICE_WAIT_MESSAGE =
  "The questions were spoken through autonomous voice. Stop now and wait for the user's next message; it will arrive as an ordinary user message.";

export function formatVoiceQuestionPrompt(params: QuestionParams): string {
  const numberQuestions = params.questions.length > 1;
  return params.questions
    .map((question, questionIndex) => {
      const heading = `${numberQuestions ? `${questionIndex + 1}. ` : ''}${question.question}${question.multiSelect ? ' (Select all that apply.)' : ''}`;
      const options = question.options.map((option, optionIndex) => `  ${optionIndex + 1}. ${option.label}`);
      return [heading, ...options, '  Type something.'].join('\n');
    })
    .join('\n\n');
}

export class VoiceQuestionHandoff {
  constructor(
    private readonly modes: Pick<MinorModeCatalogService, 'list'>,
    private readonly narration: Pick<DoomNarrationService, 'request'>,
    private readonly buildNarration: (params: QuestionParams) => string = buildVoiceQuestionNarration,
  ) {}

  async handoff(params: QuestionParams): Promise<QuestionnaireResult | undefined> {
    if (!this.modes.list().some((record) => isAutonomousVoiceRecord(record))) return undefined;
    const narration = createNarrationRequest(this.buildNarration(params));
    if (!narration) return undefined;
    await this.narration.request(narration);
    return {
      answers: [],
      cancelled: false,
      delivery: 'voice',
      awaitingResponse: true,
      voicePrompt: formatVoiceQuestionPrompt(params),
    };
  }
}

/** Create a handoff from services whose lifecycle is owned by a Cordis injection. */
export function createVoiceQuestionHandoff(
  modes: Pick<MinorModeCatalogService, 'list'>,
  narration: Pick<DoomNarrationService, 'request'>,
): VoiceQuestionHandoff {
  return new VoiceQuestionHandoff(modes, narration);
}

export function buildVoiceToolResult(details: QuestionnaireResult): ToolTextResult {
  const prompt = details.voicePrompt?.trim();
  return {
    content: [{ type: 'text', text: prompt ? `${prompt}\n\n${VOICE_WAIT_MESSAGE}` : VOICE_WAIT_MESSAGE }],
    details,
    terminate: true,
  };
}
