import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookModules } from '../../src/services/hookModules';
import type { HookContext, HookNativeEvent } from '../../src/types/hookModule';
import type { ResolvedHook } from '../../src/types/hooks';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(body: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-module-'));
  directories.push(directory);
  const artifact = path.join(directory, 'hook.mjs');
  const source = path.join(directory, 'hook.ts');
  const file = path.join(directory, 'descriptor.json');
  await fs.writeFile(artifact, body);
  await fs.writeFile(file, JSON.stringify({ version: 1, modules: [{ source, artifact, receipt: {}, rows: [] }] }));
  const modules = createHookModules({ descriptor: { file } });
  const row: ResolvedHook = { hook: { module: source }, root: directory, rowId: '0', event: 'PreToolUse' };
  const context: HookContext = {
    sessionId: 'parent',
    isSubagent: false,
    cwd: directory,
    repoRoot: directory,
    signal: new AbortController().signal,
    sendMessage: vi.fn(async () => undefined),
    appendCustomEntry: vi.fn(async () => undefined),
  };
  const event = {
    type: 'tool_call',
    toolCallId: 'call',
    toolName: 'bash',
    input: { command: 'true' },
  } as HookNativeEvent;
  return { modules, row, context, event };
}
describe('session module runtime', () => {
  it('sets up lazily once across rows, serializes calls and isolates session state', async () => {
    const { modules, row, context, event } = await fixture(
      `export default {setup(ctx) { let count=0; ctx.appendCustomEntry('setup',{}); return {async tool_call(){ const next=++count; await new Promise(r=>setTimeout(r,5)); return {reason:String(next)}; },dispose(){ctx.appendCustomEntry('disposed',{}).catch(()=>{});} }; }};`,
    );
    expect(context.appendCustomEntry).not.toHaveBeenCalled();
    const results = await Promise.all([
      modules.invoke(row, event, context),
      modules.invoke({ ...row, rowId: '1' }, event, context),
    ]);
    expect(results.map((outcome) => outcome.result)).toEqual([{ reason: '1' }, { reason: '2' }]);
    expect(context.appendCustomEntry).toHaveBeenCalledTimes(1);
    expect((await modules.invoke(row, event, { ...context, sessionId: 'child', isSubagent: true })).result).toEqual({
      reason: '1',
    });
    await modules.dispose();
    await modules.dispose();
    expect((await modules.invoke(row, event, context)).failure).toBeDefined();
  });
  it('reports missing descriptor as sync required without reading source', async () => {
    const { row, context, event } = await fixture('throw new Error("must not load")');
    const modules = createHookModules();
    expect((await modules.invoke(row, event, context)).failure?.message).toContain('sync required');
    await modules.dispose();
  });
  it('quarantines setup failures but retries handler throws and invalid results', async () => {
    const broken = await fixture('export default {setup(){throw new Error("setup failed")}}');
    expect((await broken.modules.invoke(broken.row, broken.event, broken.context)).failure?.message).toContain(
      'setup failed',
    );
    expect((await broken.modules.invoke(broken.row, broken.event, broken.context)).failure?.message).toContain(
      'quarantined',
    );
    await broken.modules.dispose();
    const running = await fixture(
      'export default {setup(){let n=0;return {tool_call(){if(++n===1)throw new Error("handler failed");if(n===2)return {block:"bad"};return {block:true};}}}}',
    );
    expect((await running.modules.invoke(running.row, running.event, running.context)).failure).toBeDefined();
    expect((await running.modules.invoke(running.row, running.event, running.context)).failure?.reason).toBe(
      'invalid_result',
    );
    expect((await running.modules.invoke(running.row, running.event, running.context)).result).toEqual({ block: true });
    await running.modules.dispose();
  });
  it.each(['setup', 'handler'])('quarantines %s timeout and revokes late effects', async (phase) => {
    const setup =
      phase === 'setup' ? 'await new Promise(r=>setTimeout(r,40)); await ctx.sendMessage("late","steer");' : '';
    const handler =
      phase === 'handler' ? 'await new Promise(r=>setTimeout(r,40)); await ctx.sendMessage("late","steer");' : '';
    const f = await fixture(
      `export default {async setup(ctx){${setup} return {async tool_call(event,ctx){${handler}return {block:true};}}}}`,
    );
    f.row.hook.timeout = 0.01;
    expect((await f.modules.invoke(f.row, f.event, f.context)).failure?.reason).toBe('timeout');
    expect((await f.modules.invoke(f.row, f.event, f.context)).failure?.message).toContain('quarantined');
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(f.context.sendMessage).not.toHaveBeenCalled();
    await f.modules.dispose();
  });
  it('disposes once and blocks agent_settled messages including setup context', async () => {
    const f = await fixture('export default {setup(){return {}}}');
    // Use an observable artifact-local disposal counter instead of host context effects.
    const artifact = path.join(f.context.cwd, 'hook.mjs');
    const marker = path.join(f.context.cwd, 'disposed');
    await fs.writeFile(
      artifact,
      `import fs from 'node:fs'; export default {setup(ctx){return {agent_settled(){return ctx.sendMessage('stop','steer')},dispose(){fs.appendFileSync(${JSON.stringify(marker)},'x');}}}}`,
    );
    const event = { type: 'agent_settled' } as HookNativeEvent;
    expect((await f.modules.invoke(f.row, event, f.context)).failure?.message).toContain('cannot send messages');
    expect(f.context.sendMessage).not.toHaveBeenCalled();
    await Promise.all([f.modules.dispose(), f.modules.dispose()]);
    expect(await fs.readFile(marker, 'utf8')).toBe('x');
  });
  it('propagates admission errors even when module catches them', async () => {
    const f = await fixture(
      `export default {setup(){return {async tool_call(e,ctx){try{await ctx.sendMessage('hi','steer')}catch{}return {block:true}}}}}`,
    );
    const error = new Error('host admission failed');
    f.context.sendMessage = vi.fn(async () => {
      throw error;
    });
    await expect(f.modules.invoke(f.row, f.event, f.context)).rejects.toBe(error);
    await f.modules.dispose();
  });
  it('aborts pending handlers on disposal without accepting late results', async () => {
    const f = await fixture(
      `export default {setup(){return {async tool_call(e,ctx){await new Promise(r=>setTimeout(r,30));await ctx.appendCustomEntry('late',{});return {block:true}}}}}`,
    );
    const pending = f.modules.invoke(f.row, f.event, f.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.modules.dispose();
    expect((await pending).failure).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(f.context.appendCustomEntry).not.toHaveBeenCalled();
  });
  it('keeps setup signal lifetime scoped when handler operation is aborted', async () => {
    const f = await fixture(
      `export default {setup(ctx){return {async tool_call(e,call){if(ctx.signal===call.signal)throw new Error('signals must differ');await new Promise(r=>setTimeout(r,40));return {block:true}}}}}`,
    );
    const operation = new AbortController();
    const pending = f.modules.invoke(f.row, f.event, f.context, operation.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    operation.abort();
    expect((await pending).failure?.message).toContain('aborted');
    await f.modules.dispose();
  });
  it('rejects raw TypeScript artifacts and invalid lifecycle returns', async () => {
    const f = await fixture('export default {setup(){return {session_start(){return {block:true}}}}}');
    expect(
      (await f.modules.invoke(f.row, { type: 'session_start' } as HookNativeEvent, f.context)).failure?.reason,
    ).toBe('invalid_result');
    await f.modules.dispose();
    const file = path.join(f.context.cwd, 'raw.json');
    const source = 'module' in f.row.hook ? f.row.hook.module : '';
    await fs.writeFile(file, JSON.stringify({ version: 1, modules: [{ source, artifact: source }] }));
    const modules = createHookModules({ descriptor: { file } });
    expect((await modules.invoke(f.row, f.event, f.context)).failure?.message).toContain(
      'invalid hook module artifact',
    );
    await modules.dispose();
  });
  it.each([
    'undefined',
    '{content:[{type:"text",text:"patched"}],details:{nested:[1,true,null,"s"]},isError:false}',
    '{content:[{type:"image",data:"abc",mimeType:"image/png"}]}',
    '{details:new Date()}',
    '{details:Infinity}',
    '{content:[{type:"text",text:42}]}',
    '{isError:"bad"}',
    '{unknown:true}',
    'null',
  ])('validates native tool result %s', async (expression) => {
    const f = await fixture(`export default {setup(){return {tool_result(){return ${expression}}}}}`);
    const outcome = await f.modules.invoke(f.row, { type: 'tool_result' } as HookNativeEvent, f.context);
    if (expression === 'undefined' || expression.includes('patched') || expression.includes('image/png')) {
      expect(outcome.failure).toBeUndefined();
    } else {
      expect(outcome.failure?.reason).toBe('invalid_result');
    }
    await f.modules.dispose();
  });
});
