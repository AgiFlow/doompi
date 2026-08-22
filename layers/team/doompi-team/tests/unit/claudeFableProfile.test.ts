import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_FABLE_MODEL,
  CLAUDE_FABLE_PROFILE,
  cleanupClaudeFableLaunch,
  cleanupStaleClaudeFableSandboxes,
  parseClaudeFableOutput,
  prepareClaudeFableLaunch,
} from '../../src/adapters/runs/shared/claudeFableProfile';

const cleanup: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-profile-test-'));
  cleanup.push(root);
  return root;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe('Claude Fable secure launch profile', () => {
  it('uses fixed argv, repository cwd, private files, stdin, and a minimal environment', () => {
    const repositoryCwd = tempRoot();
    const privateRoot = tempRoot();
    const repositoryMode = fs.statSync(repositoryCwd).mode & 0o777;
    const launch = prepareClaudeFableLaunch({
      runId: 'run-1',
      prompt: 'UNTRUSTED EVIDENCE: inspect the typed findings only.',
      repositoryCwd,
      privateRoot,
      environment: {
        HOME: '/safe/home',
        PATH: '/safe/bin',
        LANG: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'must-not-pass',
        PI_SESSION_FILE: '/secret/session.jsonl',
        DOOM_TEAM_MEMBER_TOKEN: 'must-not-pass',
        OTEL_EXPORTER_OTLP_HEADERS: 'must-not-pass',
        PROJECT_CWD: '/repo',
      },
    });

    expect(launch.profile).toBe(CLAUDE_FABLE_PROFILE);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--max-turns',
        '60',
        '--output-format',
        'stream-json',
        '--model',
        CLAUDE_FABLE_MODEL,
        '--strict-mcp-config',
        '--disallowedTools',
      ]),
    );
    expect(launch.args.join(' ')).not.toContain('UNTRUSTED EVIDENCE');
    const denyIndex = launch.args.indexOf('--disallowedTools');
    expect(denyIndex).toBeGreaterThanOrEqual(0);
    expect(launch.args[denyIndex + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit');
    expect(launch.cwd).toBe(repositoryCwd);
    expect(path.dirname(launch.stdinPath)).toContain(`${privateRoot}${path.sep}fable-`);
    expect(launch.stdinPath).toBe(path.join(path.dirname(launch.stdinPath), 'prompt.txt'));
    const promptText = fs.readFileSync(launch.stdinPath, 'utf8');
    expect(promptText).toContain('UNTRUSTED EVIDENCE');
    expect(promptText).toContain('repository-aware planning draft worker');
    expect(promptText).not.toContain('no repository access');
    expect(fs.readFileSync(path.join(path.dirname(launch.stdinPath), 'mcp.json'), 'utf8')).toBe('{"mcpServers":{}}\n');
    expect(fs.statSync(launch.cwd).mode & 0o777).toBe(repositoryMode);
    expect(fs.statSync(path.dirname(launch.stdinPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(launch.stdinPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(path.dirname(launch.stdinPath), 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(launch.env).toEqual({ HOME: '/safe/home', PATH: '/safe/bin', LANG: 'en_US.UTF-8' });

    cleanupClaudeFableLaunch(launch);
    expect(fs.existsSync(launch.cwd)).toBe(true);
    expect(fs.existsSync(path.dirname(launch.stdinPath))).toBe(false);
  });

  it('fails closed without PATH or HOME and rejects unsafe prompts', () => {
    const root = tempRoot();
    expect(() =>
      prepareClaudeFableLaunch({
        runId: 'run',
        prompt: 'evidence',
        repositoryCwd: root,
        privateRoot: tempRoot(),
        environment: { HOME: '/home' },
      }),
    ).toThrow('requires PATH');
    expect(() =>
      prepareClaudeFableLaunch({
        runId: 'run',
        prompt: 'evidence',
        repositoryCwd: root,
        privateRoot: tempRoot(),
        environment: { PATH: '/bin' },
      }),
    ).toThrow('requires HOME');
    expect(() =>
      prepareClaudeFableLaunch({
        runId: 'run',
        prompt: 'bad\u0000prompt',
        repositoryCwd: root,
        privateRoot: tempRoot(),
        environment: { HOME: '/home', PATH: '/bin' },
      }),
    ).toThrow('control characters');
    expect(() =>
      prepareClaudeFableLaunch({
        runId: 'run',
        prompt: 'x'.repeat(65 * 1_024),
        repositoryCwd: root,
        privateRoot: tempRoot(),
        environment: { HOME: '/home', PATH: '/bin' },
      }),
    ).toThrow('bounded prompt');
  });

  it('parses a complete stream and retains only bounded assistant text', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Draft fragment' }] } }),
      JSON.stringify({ type: 'result', result: 'Final result' }),
    ].join('\n');

    expect(parseClaudeFableOutput(stream)).toMatchObject({ text: 'Draft fragment\nFinal result' });
  });

  it.each([
    ['', 'stream was empty'],
    ['not-json', 'Malformed Fable Claude stream'],
    [JSON.stringify({ type: 'assistant', message: { content: [] } }), 'Incomplete Fable Claude stream'],
    [JSON.stringify({ type: 'result', result: '' }), 'Incomplete Fable Claude stream'],
  ])('rejects incomplete or malformed stream %#', (stream, message) => {
    expect(() => parseClaudeFableOutput(stream)).toThrow(message);
  });

  it('rejects oversized streams and oversized final text by UTF-8 bytes', () => {
    expect(() => parseClaudeFableOutput('x'.repeat(65 * 1_024))).toThrow('stream exceeds');
    const oversized = JSON.stringify({ type: 'result', result: 'é'.repeat(9 * 1_024) });
    expect(() => parseClaudeFableOutput(oversized)).toThrow('bounded result');
  });

  it('removes only stale private Fable sandboxes', () => {
    const root = tempRoot();
    const stale = path.join(root, 'fable-stale');
    const fresh = path.join(root, 'fable-fresh');
    const unrelated = path.join(root, 'other');
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(unrelated);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    fs.utimesSync(stale, old, old);

    cleanupStaleClaudeFableSandboxes(root);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
