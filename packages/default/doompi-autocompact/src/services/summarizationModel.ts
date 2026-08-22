import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const THINKING_SUFFIX_PATTERN = /:(off|minimal|low|medium|high|xhigh|max)$/;

export interface SummarizationModel {
  model: NonNullable<ExtensionContext['model']>;
  thinkingLevel?: NonNullable<ExtensionContext['thinkingLevel']>;
}

export interface ModelReference {
  provider: string;
  modelId: string;
  thinking?: NonNullable<ExtensionContext['thinkingLevel']>;
}

/** Splits a `provider/model` reference, tolerating the optional thinking suffix. */
export function parseModelReference(reference: string): ModelReference | undefined {
  const trimmed = reference.trim();
  const thinking = THINKING_SUFFIX_PATTERN.exec(trimmed)?.[1] as SummarizationModel['thinkingLevel'];
  const identity = trimmed.replace(THINKING_SUFFIX_PATTERN, '');
  const separator = identity.indexOf('/');
  if (separator <= 0 || separator >= identity.length - 1) return undefined;
  return {
    provider: identity.slice(0, separator),
    modelId: identity.slice(separator + 1),
    ...(thinking ? { thinking } : {}),
  };
}

/** Standard Pi model selection never consults Doom configuration. */
export function resolveSummarizationModel(ctx: ExtensionContext): SummarizationModel | undefined {
  if (!ctx.model) return undefined;
  return {
    model: ctx.model,
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
  };
}
