import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { GrepToolMessage } from '../../../../../web/components/GrepToolMessage';

/**
 * The grep tool's timeline card, the web half of the TUI's renderCall and
 * renderResult for hashline searches. The filename binds it to the tool.
 */
export default defineToolRenderer({ message: GrepToolMessage });
