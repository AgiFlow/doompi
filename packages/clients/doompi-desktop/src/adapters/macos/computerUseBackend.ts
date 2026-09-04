import { systemPreferences } from 'electron';
import type { ComputerUseBackend } from '../../types/computerUse.ts';

export function createMacOsComputerUseBackend(): ComputerUseBackend {
  return {
    async status() {
      return {
        platform: process.platform,
        accessibility: systemPreferences.isTrustedAccessibilityClient(false),
        screenRecording: systemPreferences.getMediaAccessStatus('screen'),
        nativeAdapter: 'unavailable',
      };
    },
    async targets() {
      return {
        targets: [],
        error: 'The signed macOS computer-use adapter has not passed its packaged-app capability probe.',
      };
    },
    async activate() {
      throw new Error('The signed macOS computer-use adapter is unavailable.');
    },
    async observe() {
      throw new Error('The signed macOS computer-use adapter is unavailable.');
    },
    async act() {
      throw new Error('The signed macOS computer-use adapter is unavailable.');
    },
    async stop() {},
  };
}
