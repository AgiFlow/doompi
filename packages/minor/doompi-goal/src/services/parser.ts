import { MAX_OBJECTIVE_LENGTH } from '../types/goal.ts';

export type GoalCommandKind = 'start' | 'pause' | 'resume' | 'clear' | 'show' | 'edit';
export interface GoalCommandResult {
  kind: GoalCommandKind;
  objective?: string;
  tokenBudget?: number;
}
export interface GoalArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const COMMON: readonly GoalArgumentCompletion[] = [
  { value: 'pause', label: 'pause', description: 'Pause the active goal' },
  { value: 'resume', label: 'resume', description: 'Resume a stopped goal' },
  { value: 'clear', label: 'clear', description: 'Clear the current goal' },
  { value: 'edit', label: 'edit', description: 'Edit the current goal objective' },
  { value: 'status', label: 'status', description: 'Show the current goal' },
];
export function completeGoalArguments(prefixInput: string): GoalArgumentCompletion[] | null {
  const prefix = prefixInput.trimStart();
  const completions = [...COMMON, { value: '--tokens ', label: '--tokens', description: 'Set a token budget' }];
  if (!prefix) return completions;
  const match = /^edit\s+(\S*)$/u.exec(prefix);
  if (match) {
    const optionPrefix = match[1] ?? '';
    return optionPrefix === '' || '--tokens'.startsWith(optionPrefix)
      ? [{ value: 'edit --tokens ', label: '--tokens', description: 'Set a token budget' }]
      : null;
  }
  if (/\s/u.test(prefix)) return null;
  const matches = completions.filter((item) => item.value.startsWith(prefix) || item.label.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}

export function parseGoalCommand(args: string): GoalCommandResult | string {
  const tokens = tokenize(args.trim());
  if (tokens.length === 0) return { kind: 'show' };
  const [first, ...rest] = tokens;
  if (first === 'pause') return rest.length === 0 ? { kind: 'pause' } : 'Usage: /goal pause';
  if (first === 'resume') return rest.length === 0 ? { kind: 'resume' } : 'Usage: /goal resume';
  if (first === 'clear' || first === 'stop') return rest.length === 0 ? { kind: 'clear' } : 'Usage: /goal clear';
  if (first === 'status') return rest.length === 0 ? { kind: 'show' } : 'Usage: /goal status';
  if (first === 'edit') return parseObjective('edit', rest);
  return parseObjective('start', tokens);
}
export const parseCommand = parseGoalCommand;

function parseObjective(kind: 'start' | 'edit', tokens: string[]): GoalCommandResult | string {
  const objectiveTokens = [...tokens];
  let tokenBudget: number | undefined;
  if (objectiveTokens[0] === '--tokens') {
    const rawBudget = objectiveTokens[1];
    if (!rawBudget)
      return kind === 'start'
        ? 'Usage: /goal --tokens 100k <goal_to_complete>'
        : `Usage: /goal ${kind} --tokens 100k <goal_to_complete>`;
    tokenBudget = parseTokenBudget(rawBudget);
    if (tokenBudget === undefined) return `Invalid token budget: ${rawBudget}`;
    objectiveTokens.splice(0, 2);
  }
  if (!objectiveTokens.length)
    return kind === 'start' ? 'Usage: /goal <goal_to_complete>' : `Usage: /goal ${kind} <goal_to_complete>`;
  return { kind, objective: objectiveTokens.join(' '), tokenBudget };
}

export function parseTokenBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  const result = Math.floor(amount * multiplier);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return 'Usage: /goal <goal_to_complete>';
  return trimmed.length > MAX_OBJECTIVE_LENGTH
    ? `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`
    : undefined;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}
