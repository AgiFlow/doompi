import type { Static } from 'typebox';

import type { SessionMethodSchemas, SessionServiceStateSchema } from '../../../src/schemas/sessionApiContracts';
import type { SessionService, SessionServiceState } from '../../../src/schemas/sessionProtocol';

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type PublicMembers = Exclude<keyof SessionService, 'state'>;
type Checks = [
  Assert<Equal<PublicMembers, keyof typeof SessionMethodSchemas>>,
  Assert<Equal<SessionServiceState, Static<typeof SessionServiceStateSchema>>>,
  Assert<Equal<Awaited<ReturnType<SessionService['getState']>>, Static<typeof SessionMethodSchemas.getState.output>>>,
  Assert<
    Equal<
      Awaited<ReturnType<SessionService['getSessionStats']>>,
      Static<typeof SessionMethodSchemas.getSessionStats.output>
    >
  >,
  Assert<
    Equal<Awaited<ReturnType<SessionService['getCommands']>>, Static<typeof SessionMethodSchemas.getCommands.output>>
  >,
];
declare const checks: Checks;
void checks;
declare const actual: SessionServiceState;
declare const documented: Static<typeof SessionServiceStateSchema>;
const checkActual: Static<typeof SessionServiceStateSchema> = actual;
const checkDocumented: SessionServiceState = documented;
void checkActual;
void checkDocumented;
