// A Doom server host loads the module's default export as its facet entry contract.
import { createRunnerContainer } from '../../container/index.ts';
import { createRunnerServerFacet } from '../../adapters/server/facet.ts';

export const runnerServerFacet = createRunnerServerFacet(() => createRunnerContainer());
export default runnerServerFacet;
