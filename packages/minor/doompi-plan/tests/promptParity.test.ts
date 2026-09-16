import { describe, expect, it } from 'vitest';

import { buildFlavorPlanningPrompt, buildPlanModeBasePrompt, type PlanHostCapabilities } from '../src/exports/prompts';
import { PLAN_CLI_CAPABILITIES } from '../src/services/planMode';
import { PLAN_SERVER_CAPABILITIES } from '../src/services/planServerSession';

const PLANS_DIRECTORY = '/private/plans';

/** Assemble the way both facets do: the shared base block, then the flavor block. */
function assemble(capabilities: PlanHostCapabilities): string {
  return [
    buildPlanModeBasePrompt(PLANS_DIRECTORY, capabilities),
    buildFlavorPlanningPrompt('normal', PLANS_DIRECTORY, undefined, 'idle', capabilities),
  ].join('\n\n');
}

function sentencesOf(prompt: string): string[] {
  return prompt
    .split('\n')
    .flatMap((line) => line.split(/(?<=\.)\s+/u))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

describe('plan mode prompt parity', () => {
  it('the two hosts differ only by their declared capabilities', () => {
    const cli = assemble(PLAN_CLI_CAPABILITIES).split('\n');
    const server = assemble(PLAN_SERVER_CAPABILITIES).split('\n');

    // The server's complete_plan declares no parameters and has no narrated review, so these are
    // the only sentences it must not receive. A fourth divergence is drift, not a capability.
    expect(cli.filter((line) => !server.includes(line))).toEqual([
      'In an interactive text session, call complete_plan without a decision and it opens the exit-or-continue selector.',
      'Under autonomous voice, complete_plan displays and narrates the choices without opening a blocking dialog, then ends the turn.',
      'Interpret the user\'s next ordinary message and call complete_plan again with decision "exit" or "continue".',
    ]);
    expect(server.filter((line) => !cli.includes(line))).toEqual([]);
  });

  it.each([
    ['cli', PLAN_CLI_CAPABILITIES],
    ['server', PLAN_SERVER_CAPABILITIES],
  ] as const)('states each %s planning instruction exactly once', (_host, capabilities) => {
    const sentences = sentencesOf(assemble(capabilities));

    expect(sentences.filter((sentence, index) => sentences.indexOf(sentence) !== index)).toEqual([]);
  });
});
