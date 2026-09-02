import type { ToolEntry, ToolSource } from './toolInventory.ts';

/**
 * What one tool costs before anything is asked of it.
 *
 * A tool is sent to the model twice over. Its schema travels in the tool list,
 * and its prose travels in the system prompt: Pi's `BuildSystemPromptOptions`
 * takes `toolSnippets` keyed by tool name and `promptGuidelines` appended to the
 * default guidelines, separately from the tools themselves. Pricing only the
 * schema would undercount every tool that carries either, so the two are counted
 * apart and reported together.
 *
 * The tokenizer is injected rather than imported, matching how MCP schema
 * pricing already takes a `countTokens`. This module stays free of any opinion
 * about which vocabulary the caller's model actually uses.
 */
export interface ToolCost {
  /** The tool-list payload: name, description, and parameter schema. */
  schemaTokens: number;
  /** The system-prompt payload: snippet and guideline bullets. */
  promptTokens: number;
  totalTokens: number;
}

export type CountTokens = (text: string) => number;

/** Mirrors the wire shape MCP advertises, so both estimates stay comparable. */
function schemaPayload(entry: ToolEntry): string {
  return JSON.stringify({
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.parameters === undefined ? {} : { parameters: entry.parameters }),
  });
}

function promptPayload(entry: ToolEntry): string {
  return [entry.promptSnippet ?? '', ...(entry.promptGuidelines ?? [])].filter(Boolean).join('\n');
}

export function tokensForTool(entry: ToolEntry, countTokens: CountTokens): ToolCost {
  const schemaTokens = countTokens(schemaPayload(entry));
  const prompt = promptPayload(entry);
  const promptTokens = prompt.length === 0 ? 0 : countTokens(prompt);
  return { schemaTokens, promptTokens, totalTokens: schemaTokens + promptTokens };
}

/**
 * Every tool in a source, and what the source costs in total.
 *
 * An inactive tool is still priced: it is in the composition, and the point of
 * the figure is to show what the composition costs. Whether the model may call
 * it is a separate question from whether it is being paid for.
 */
export function tokensForSource(
  source: ToolSource,
  countTokens: CountTokens,
): { tools: ReadonlyMap<string, ToolCost>; totalTokens: number } {
  const tools = new Map<string, ToolCost>();
  let totalTokens = 0;
  for (const entry of source.tools) {
    const cost = tokensForTool(entry, countTokens);
    tools.set(entry.name, cost);
    totalTokens += cost.totalTokens;
  }
  return { tools, totalTokens };
}
