import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type root from '../root.cli';

type Context = WithRoot<unknown, Awaited<ReturnType<typeof root>>['value']>;

export default defineRoutedContribution((context: Context) => context.root.tools ?? [], { cardinality: 'collection' });
