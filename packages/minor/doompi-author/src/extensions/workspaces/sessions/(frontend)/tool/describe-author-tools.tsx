import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { DescribeAuthorToolsToolCard } from '../../../../../web/components/DescribeAuthorToolsToolCard';

export default defineToolRenderer({ tools: ['describe_author_tools'], message: DescribeAuthorToolsToolCard });
