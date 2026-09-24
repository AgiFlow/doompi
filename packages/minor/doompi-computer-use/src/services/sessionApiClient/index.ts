import type { ComputerUseSessionClient } from '../../types/computerUse';

export type { ComputerUseSessionClient } from '../../types/computerUse';

/** Uses the injected host-owned service. Absence never triggers transport or credential discovery. */
export function createComputerUseSessionClient(host?: ComputerUseSessionClient): ComputerUseSessionClient | undefined {
  return host;
}
