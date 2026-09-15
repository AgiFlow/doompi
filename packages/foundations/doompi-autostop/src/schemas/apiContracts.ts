import { defineApiContract } from '@agimon-ai/doompi-core/api-contracts';

/** This facet contributes agent tools, commands or lifecycle only, with no separate HTTP or socket surface. */
export const apiContracts = defineApiContract({ version: 1, http: [], sockets: [], dynamic: [] });
export default apiContracts;
