import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

import { api } from '../../../../services/previewApi';

export default defineRoot(() => ({ value: { api: [api] } }));
