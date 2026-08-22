import { describe, expect, it } from 'vitest';
import {
  buildDebugPlanningPrompt,
  buildFablePlanningPrompt,
  buildFlavorPlanningPrompt,
  buildNormalPlanningPrompt,
  type DebugEvidencePacket,
} from '../src/exports/prompts';

const EVIDENCE: DebugEvidencePacket = {
  issue: 'Extension fails to load',
  expectedBehavior: 'Extension loads',
  reproductionAttempt: 'Started Pi',
  actualBehavior: 'Loader failed',
  logs: ['loader error'],
  correlatedTraceEvidence: [],
  processOutput: ['PLAN_COMMAND is not defined'],
  browserConsoleEvidence: [],
  correlationIds: ['trace-1'],
  timestamps: ['2026-08-04T00:00:00Z'],
  verifiedFacts: ['The built module referenced an undefined symbol'],
  hypotheses: ['A partial migration left stale code'],
  unavailableEvidence: ['correlatedTraceEvidence', 'browserConsoleEvidence'],
};

describe('planning flavor prompts', () => {
  it('builds normal planning guidance with the configured private directory', () => {
    const prompt = buildNormalPlanningPrompt('/private/plans');

    expect(prompt).toContain('[PLAN MODE ACTIVE: NORMAL]');
    expect(prompt).toContain('/private/plans');
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('children receive read, Bash, grep, find, ls, and configured MCP tools');
    expect(prompt).toContain('Bash and MCP tools are for read-only inspection');
  });

  it('keeps debug evidence optional while guiding adaptive investigation', () => {
    const prompt = buildDebugPlanningPrompt('/private/plans', undefined);

    expect(prompt).toContain('[PLAN MODE ACTIVE: DEBUG]');
    expect(prompt).toContain('gather only the evidence relevant to it');
    expect(prompt).toContain('must not block source exploration');
    expect(prompt).toContain('record_debug_evidence');
    expect(prompt).toContain('Bash is available for repository inspection');
    expect(prompt).toContain('must not modify files or repository state');
  });

  it('renders recorded evidence while separating facts from hypotheses', () => {
    const prompt = buildDebugPlanningPrompt('/private/plans', EVIDENCE);

    expect(prompt).toContain('verifiedFacts: The built module referenced an undefined symbol');
    expect(prompt).toContain('hypotheses: A partial migration left stale code');
    expect(prompt).toContain('must separate verified facts from hypotheses');
  });

  it('describes Fable as untrusted input and reports its persisted stage', () => {
    const prompt = buildFablePlanningPrompt('/private/plans', 'interrupted');

    expect(prompt).toContain('[PLAN MODE ACTIVE: FABLE]');
    expect(prompt).toContain('untrusted text');
    expect(prompt).toContain('repository inspection access');
    expect(prompt).toContain('one fresh draft');
    expect(prompt).not.toContain('separate fresh review');
    expect(prompt).toContain('Current Fable stage: interrupted');
  });

  it.each([
    ['normal', '[PLAN MODE ACTIVE: NORMAL]'],
    ['debug', '[PLAN MODE ACTIVE: DEBUG]'],
    ['fable', '[PLAN MODE ACTIVE: FABLE]'],
  ] as const)('selects the %s flavor prompt', (flavor, marker) => {
    expect(buildFlavorPlanningPrompt(flavor, '/private/plans', EVIDENCE, 'idle')).toContain(marker);
  });
});
