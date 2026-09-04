// @scaffold-generated
/**
 * View types shared by this package's hub channel and its web plugin. Wire
 * JSON only, no node types, so the cockpit bundle can carry them; the
 * cockpit receives them as 'computer_use_state' channel payloads.
 */

/** One item of a session, as the cockpit shows it. Replace with the real record. */
export interface ComputerUseItemView {
  id: string;
  name: string;
  state: 'running' | 'done';
}

/** The frame type the hub publishes and the web plugin claims; declared in the doompiWeb block too. */
export const computerUseChannelType = 'computer_use_state';
