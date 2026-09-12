import { EXTENSION_SOURCE, CONTINUE } from '../constants/inputCapture';
import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import type { RecentPrompts } from '../types/prompt';

/**
 * Staging what the user submits.
 *
 * DESIGN PATTERNS:
 * - Listens on the host's input event, which carries the raw text before skill
 *   and template expansion. This keeps the editor component untouched, so
 *   arrow up/down behaviour is exactly Pi's and cannot regress here.
 * - Stages interactive and RPC input, which are the two ways a person submits a
 *   prompt. Text an extension injected is that extension's business, not
 *   something the user asked to reuse.
 *
 * AVOID:
 * - Returning anything but continue. This handler observes, it never rewrites.
 */

export function createInputCapture(recent: RecentPrompts): PiEventHandlers['input'] {
  return (event) => {
    if (event.source !== EXTENSION_SOURCE) recent.push(event.text);
    return CONTINUE;
  };
}
