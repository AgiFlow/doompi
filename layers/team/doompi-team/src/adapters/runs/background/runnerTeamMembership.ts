/**
 * Thin composition seam over `nativeTeamChannel.ts`'s registration
 * functions, the same shape as `RunnerRevivalLease` over `session-lease.ts`:
 * no logic of its own, just an injectable wrapper so `RunnerBootstrap` can be
 * tested without writing real team files to disk.
 *
 * ERROR POLICY LIVES IN THE CALLER, NOT HERE:
 * `register()` throws exactly what `registerNativeTeamMember()` throws;
 * whether that is fatal to the run is `RunnerBootstrap`'s decision (it is
 * not - see that class's header for why team membership is additive), not
 * this wrapper's.
 */

import {
  type RegisterNativeTeamMemberInput,
  readNativeTeamRootFromEnvironment,
  registerNativeTeamMember,
  type TeamMemberContext,
  type TeamRootContext,
} from '../../intercom/nativeTeamChannel';

export interface RunnerTeamRegistration {
  context: TeamMemberContext;
  dispose: () => void;
}

export type RunnerTeamMembershipContract = {
  /** This process's own team root context, if one was forwarded by whatever spawned it. `undefined` when this run is not part of a team. */
  readRoot(): TeamRootContext | undefined;
  /** Join the team as a new member. Throws on failure - see `RunnerBootstrap` for what it does with that. */
  register(input: RegisterNativeTeamMemberInput): RunnerTeamRegistration;
};

export class RunnerTeamMembership implements RunnerTeamMembershipContract {
  readRoot(): TeamRootContext | undefined {
    return readNativeTeamRootFromEnvironment();
  }

  register(input: RegisterNativeTeamMemberInput): RunnerTeamRegistration {
    return registerNativeTeamMember(input);
  }
}
