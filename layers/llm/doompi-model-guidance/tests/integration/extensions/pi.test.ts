import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harnessState = { root: undefined as string | undefined };

vi.mock('@agimon-ai/doompi-config', () => ({
  getHarnessState: () => harnessState,
}));

const { modelGuidanceEvents } = await import('../../../src/controllers/modelGuidanceEvents');

type Handler = (
  event: { systemPrompt: string },
  ctx: { model?: { id: string } },
) => { systemPrompt: string } | undefined;

let workspace: string;
let handler: Handler;

function registerHandler(): Handler {
  return (event, context) => modelGuidanceEvents.before_agent_start(event as never, context as never);
}

function writeRepositoryGuidance(contents: string): void {
  const directory = path.join(workspace, '.doom');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'model-guidance.yaml'), contents, 'utf8');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'model-guidance-pi-'));
  harnessState.root = workspace;
  handler = registerHandler();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('before_agent_start', () => {
  it('is inert when no guidance file exists', () => {
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })).toBeUndefined();
  });

  it('is inert when the active model is unknown to Pi', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n');
    expect(handler({ systemPrompt: 'base' }, {})).toBeUndefined();
  });

  it('applies the built-in GPT-6 Astra preset when no file entry overrides it', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n');
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'gpt-6-astra' } })?.systemPrompt).toContain(
      'Continue executing an agreed plan',
    );
  });

  it('is inert when the harness root is unset', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n');
    harnessState.root = undefined;
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })).toBeUndefined();
  });

  it('appends guidance for a matching model id', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n');
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })).toEqual({
      systemPrompt: 'base\n\nStay focused.',
    });
  });

  it('re-embeds an earlier contribution rather than replacing it', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n');

    const result = handler({ systemPrompt: 'EARLIER_CONTRIBUTION' }, { model: { id: 'claude-opus-5' } });

    expect(result?.systemPrompt).toContain('EARLIER_CONTRIBUTION');
    expect(result?.systemPrompt).toContain('Stay focused.');
  });

  it('follows a mid-session model switch, because the model is read each turn', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Stay focused.\n  gpt-6-astra: Batch tools.\n');

    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })?.systemPrompt).toBe(
      'base\n\nStay focused.',
    );
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'gpt-6-astra' } })?.systemPrompt).toBe(
      'base\n\nBatch tools.',
    );
  });

  it('picks up an edited guidance file on the next turn without re-registration', () => {
    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: First.\n');
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })?.systemPrompt).toBe('base\n\nFirst.');

    writeRepositoryGuidance('modelGuidance:\n  claude-opus-5: Second.\n');
    expect(handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })?.systemPrompt).toBe('base\n\nSecond.');
  });

  it('fails open on malformed YAML without ending the turn', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRepositoryGuidance('modelGuidance:\n  m: "unterminated\n   : : :\n');

    expect(() => handler({ systemPrompt: 'base' }, { model: { id: 'claude-opus-5' } })).not.toThrow();
  });
});
