import { driveChannel, renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { author, authorChannel } from '../../src/web/authorStore.ts';
import { webPlugin } from '../../src/web/index.ts';

afterEach(() => author.reset());

describe('the author tab', () => {
  it('draws the inactive foundation state', () => {
    const rendered = renderPlugin(webPlugin.tabs![0]!.panel, slotPropsFixture({ sessionId: 's1' }).props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('Author inactive');
  });

  it('draws the trusted session view', () => {
    expect(driveChannel(authorChannel, 's1', { activation: 'active', capabilityCount: 2 }).accepted).toBe(true);
    const rendered = renderPlugin(webPlugin.tabs![0]!.panel, slotPropsFixture({ sessionId: 's1' }).props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('Author active');
    expect(rendered.html).toContain('2 viewport capabilities');
  });
});
