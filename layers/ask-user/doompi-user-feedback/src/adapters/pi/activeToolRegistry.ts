import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ActiveToolRegistry } from '../../types/toolActivation.js';

/**
 * Adapts Pi's extension API to the gate's port.
 *
 * Returns undefined for a host that does not expose the runtime tool list. Those hosts
 * keep every registered tool active, so there is nothing for the gate to drive and no
 * reason to fail the install over it.
 */
export function readActiveToolRegistry(pi: ExtensionAPI): ActiveToolRegistry | undefined {
  const candidate = pi as Partial<ActiveToolRegistry>;
  if (typeof candidate.getActiveTools !== 'function' || typeof candidate.setActiveTools !== 'function') {
    return undefined;
  }
  return {
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (toolNames) => pi.setActiveTools(toolNames),
  };
}
