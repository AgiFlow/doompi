import { describe, expect, it } from 'vitest';

import { askUserToolRestriction } from '../../src/services/askUserToolGate';

const TOOL = 'ask_user_question';
const AVAILABLE = ['read', TOOL, 'bash'];

describe('askUserToolRestriction', () => {
  it('drops only its own tool while the gate is closed', () => {
    expect(askUserToolRestriction(TOOL, false)(AVAILABLE, AVAILABLE)).toEqual(['read', 'bash']);
  });

  it('passes the incoming list through untouched while the gate is open', () => {
    expect(askUserToolRestriction(TOOL, true)(AVAILABLE, AVAILABLE)).toEqual(AVAILABLE);
  });

  it('never adds a tool another owner already removed', () => {
    const narrowed = ['read'];

    expect(askUserToolRestriction(TOOL, true)(narrowed, AVAILABLE)).toEqual(narrowed);
    expect(askUserToolRestriction(TOOL, false)(narrowed, AVAILABLE)).toEqual(narrowed);
  });
});
