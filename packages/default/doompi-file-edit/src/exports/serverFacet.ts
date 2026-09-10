import { createFileEditContainer } from '../container/index.ts';
import { createFileEditsServerFacet } from '../adapters/server/facet.ts';

export const fileEditsServerFacet = createFileEditsServerFacet(createFileEditContainer);
