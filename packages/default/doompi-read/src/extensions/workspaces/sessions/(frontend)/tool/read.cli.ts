import { definePiToolRenderer } from '@agimon-ai/doompi-core/pi-extension';

import { readRenderer } from './_lib/readRenderer.cli';

export default definePiToolRenderer(readRenderer);
