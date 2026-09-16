import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { IntercomToolMessage } from '../../../../../web/components/IntercomToolMessage';

/** The intercom tool's timeline card. The filename names the tool it renders. */
export default defineToolRenderer({ message: IntercomToolMessage });
