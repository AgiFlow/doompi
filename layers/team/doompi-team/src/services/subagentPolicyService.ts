import {
  type DoomSubagentPolicyService,
  type SubagentPolicy,
  type SubagentPolicyHandle,
  SubagentPolicySchema,
} from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import { Check } from 'typebox/value';
import type { SubagentCapabilityPolicyStore } from '../schemas/team/capabilityCeiling';

function assertPolicy(policy: SubagentPolicy): void {
  if (!Check(SubagentPolicySchema, policy)) throw new TypeError('Invalid subagent policy contribution.');
}

/** Publishes Team's capability intersection store through a Cordis service. */
export function createSubagentPolicyService(store: SubagentCapabilityPolicyStore): DoomSubagentPolicyService {
  const generation = `doom-subagent-policy:${crypto.randomUUID()}`;
  const service: DoomSubagentPolicyService = {
    generation,
    register(initialPolicy: SubagentPolicy): SubagentPolicyHandle {
      assertPolicy(initialPolicy);
      const owner = initialPolicy.owner;
      const contributionGeneration = `${owner}:${crypto.randomUUID()}`;
      let policy = initialPolicy;
      let disposed = false;
      store.register(policy, contributionGeneration);
      return Object.freeze({
        owner,
        generation: contributionGeneration,
        update(nextPolicy: SubagentPolicy): void {
          if (disposed) throw new Error('Cannot update a disposed subagent policy.');
          assertPolicy(nextPolicy);
          if (nextPolicy.owner !== owner) throw new Error('Cannot change a subagent policy owner.');
          policy = nextPolicy;
          store.update(policy, contributionGeneration);
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          store.remove(owner, contributionGeneration);
        },
      });
    },
  };
  return Object.freeze(service);
}
