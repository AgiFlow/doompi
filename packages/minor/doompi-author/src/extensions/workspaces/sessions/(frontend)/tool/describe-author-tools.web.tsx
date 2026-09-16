import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { DescribeAuthorToolsToolCard } from './_components/DescribeAuthorToolsToolCard';

export default defineToolRenderer({ tools: ['describe_author_tools'], message: DescribeAuthorToolsToolCard });
