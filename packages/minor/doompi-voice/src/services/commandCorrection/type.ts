export interface VoiceCommandContext {
  pendingQuestions?: readonly string[];
  tasks?: readonly string[];
  minorModes?: readonly string[];
}

export interface VoiceCommandCorrectionInput {
  transcript: string;
  context?: VoiceCommandContext;
}

export interface VoiceCommandCorrectionModelRequest {
  systemPrompt: string;
  input: string;
  maxTokens: number;
  cacheRetention: 'none';
  signal: AbortSignal;
}

export interface IVoiceCommandCorrectionModelClient {
  complete(request: VoiceCommandCorrectionModelRequest): Promise<string>;
}

export interface IVoiceCommandCorrector {
  correct(input: VoiceCommandCorrectionInput, signal: AbortSignal): Promise<string>;
}
