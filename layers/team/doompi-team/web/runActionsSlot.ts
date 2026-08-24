import { defineSlot } from '@agimon-ai/doompi-web-contracts';

/**
 * The slot the run drawer opens beside its stop control: an independent
 * plugin may put its own action for the shown run there, without this
 * package knowing it exists. Fills receive the panel's own props.
 */
export const RUN_ACTIONS_SLOT = defineSlot({ slot: 'subagents.run-actions' });
