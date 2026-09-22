import { definePiToolRenderer } from '@agimon-ai/doompi-core/piExtension';

import { readRenderer } from './_lib/readRenderer.cli';

export default definePiToolRenderer(readRenderer);
