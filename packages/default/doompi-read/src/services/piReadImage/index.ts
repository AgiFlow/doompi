import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';

import {
  applyImageLimits as applyServiceImageLimits,
  type ReadContentPart,
  type ReadImageResizeOperations,
  type ReadImageResizeResult,
} from '../readImage';

export { imageLimits, type ReadContentPart, type ReadImagePart, type ReadTextPart } from '../readImage';

const resizeOperations: ReadImageResizeOperations = {
  resize: resizeImage,
  formatDimensionNote: (result: ReadImageResizeResult) => formatDimensionNote(result),
};

export function applyImageLimits(
  content: ReadContentPart[],
  limits: Parameters<typeof applyServiceImageLimits>[1],
): Promise<ReadContentPart[]> {
  return applyServiceImageLimits(content, limits, resizeOperations);
}
