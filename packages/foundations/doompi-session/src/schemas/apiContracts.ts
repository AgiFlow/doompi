import { defineApiContract } from '@agimon-ai/doompi-core/api-contracts';

/** Session currently contributes host services only, with no package-owned API surface. */
export const apiContracts = defineApiContract({ version: 1, http: [], sockets: [], dynamic: [] });
export default apiContracts;
