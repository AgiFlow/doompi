import { createFileEditContainer } from '../container/index.ts';
import {
  createFileEditHeadlessContributions as createAdapterContributions,
  type FileEditHeadlessContributions,
} from '../adapters/headless.ts';

export function createFileEditHeadlessContributions(): FileEditHeadlessContributions {
  return createAdapterContributions(createFileEditContainer());
}
