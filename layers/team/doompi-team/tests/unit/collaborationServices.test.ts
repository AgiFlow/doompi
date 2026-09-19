import { describe, expect, it } from 'vitest';

import { SubagentCapabilityPolicyStore } from '../../src/schemas/team/capabilityCeiling';
import { createSubagentPolicyService } from '../../src/services/subagentPolicyService';
describe('subagent-policy Cordis service', () => {
  it('updates and retracts only the current contribution generation', () => {
    const store = new SubagentCapabilityPolicyStore();
    const service = createSubagentPolicyService(store);
    const first = service.register({ owner: 'plan', allowedTools: ['read', 'grep'] });
    const replacement = service.register({ owner: 'plan', allowedTools: ['read'] });

    first.dispose();
    expect(store.resolve()?.allowedTools).toEqual(['read']);
    replacement.update({ owner: 'plan', allowedTools: ['read', 'grep'], denyExtensions: true });
    expect(store.resolve()).toMatchObject({ allowedTools: ['grep', 'read'], denyExtensions: true });
    replacement.dispose();
    expect(store.resolve()).toBeUndefined();
  });

  it('rejects malformed contributions and owner changes', () => {
    const service = createSubagentPolicyService(new SubagentCapabilityPolicyStore());
    expect(() => service.register({ owner: '' })).toThrow(/Invalid subagent policy/);
    const handle = service.register({ owner: 'plan', allowedTools: ['read'] });
    expect(() => handle.update({ owner: 'other', allowedTools: ['read'] })).toThrow(/Cannot change/);
  });
});
