import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COLLAPSE_KEY_OFF,
  DEFAULT_COLLAPSE_KEY,
  loadUserFeedbackConfig,
  resolveCollapseKey,
} from '../../src/adapters/config/configAdapter.js';

const temporaryDirectories: string[] = [];

function environmentWithConfig(contents?: string): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-feedback-config-'));
  temporaryDirectories.push(root);
  if (contents !== undefined) {
    const directory = path.join(root, 'rpiv-ask-user-question');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'config.json'), contents);
  }
  return { XDG_CONFIG_HOME: root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('legacy feedback config adapter', () => {
  it('returns defaults when the legacy file is absent, malformed, or not an object', () => {
    expect(loadUserFeedbackConfig(environmentWithConfig())).toEqual({});
    expect(loadUserFeedbackConfig(environmentWithConfig('{ invalid'))).toEqual({});
    expect(loadUserFeedbackConfig(environmentWithConfig('[]'))).toEqual({});
  });

  it('loads valid collapse and guidance fields independently', () => {
    const loaded = loadUserFeedbackConfig(
      environmentWithConfig(
        JSON.stringify({
          collapseKey: 'alt+o',
          guidance: {
            promptSnippet: 'Ask before choosing',
            promptGuidelines: ['First guideline', 'Second guideline'],
          },
        }),
      ),
    );

    expect(loaded).toEqual({
      collapseKey: 'alt+o',
      guidance: {
        promptSnippet: 'Ask before choosing',
        promptGuidelines: ['First guideline', 'Second guideline'],
      },
    });
  });

  it('ignores invalid individual fields without rejecting valid siblings', () => {
    expect(
      loadUserFeedbackConfig(
        environmentWithConfig(
          JSON.stringify({
            collapseKey: 5,
            guidance: { promptSnippet: 7, promptGuidelines: ['valid', 9] },
          }),
        ),
      ),
    ).toEqual({ guidance: {} });
    expect(
      loadUserFeedbackConfig(environmentWithConfig(JSON.stringify({ collapseKey: 'ctrl+k', guidance: 'invalid' }))),
    ).toEqual({ collapseKey: 'ctrl+k' });
  });

  it('resolves default, disabled, valid, and invalid collapse keys', () => {
    expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: '   ' })).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ collapseKey: ' OFF ' })).toBe(COLLAPSE_KEY_OFF);
    expect(resolveCollapseKey({ collapseKey: ' ALT+O ' })).toBe('alt+o');
    expect(resolveCollapseKey({ collapseKey: 'ctrl+? invalid' })).toBe(DEFAULT_COLLAPSE_KEY);
  });
});
