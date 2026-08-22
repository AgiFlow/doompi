import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiVoiceConfigService } from '../src/adapters/pi/voice.ts';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(packageDirectory, relativePath), 'utf8').catch(() => '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('doom voice extension boundaries', () => {
  it('exposes one standard Pi factory with typed host integrations folded into it', async () => {
    const piEntry = await readSource('src/exports/extensions/pi.ts');
    const standardFactory = await readSource('src/adapters/pi/extension.ts');
    const implementation = await readSource('src/adapters/pi/voice.ts');
    const alternateDoomEntry = await readSource('src/exports/extensions/doom.ts');

    expect(piEntry).toContain('voicePiExtension as default');
    expect(standardFactory).toMatch(/DOOM_UI_HUB_SERVICE/u);
    expect(standardFactory).toMatch(/register(Footer|Leader|Config)/u);
    expect(implementation).not.toMatch(/\bDoomConfigService\b|doom-pi-ui|createProtocolRuntime/u);
    expect(alternateDoomEntry).toBe('');
  });

  it('does not load project configuration blindly from the process working directory', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');

    expect(implementation).not.toMatch(/configs\.load\(process\.cwd\(\)\)/u);
    expect(implementation).toMatch(/projectTrust|trusted|untrusted/u);
  });

  it('guards manual voice commands in print, JSON, and RPC hosts', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');
    const commandStart = implementation.indexOf('pi.registerCommand(COMMAND_NAME');
    const commandEnd = implementation.indexOf(`pi.registerCommand(AUTO_COMMAND_NAME`, commandStart);
    const commandSection = implementation.slice(commandStart, commandEnd);

    expect(commandStart).toBeGreaterThanOrEqual(0);
    expect(commandEnd).toBeGreaterThan(commandStart);
    expect(commandSection).toMatch(/hasUI/u);
  });

  it('keeps production manual dictation behind the worker boundary', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');
    const controller = await readSource('src/adapters/process/voiceWorkerSessionController.ts');

    expect(implementation).toMatch(/sessionController:[^\n]*new VoiceWorkerSessionController\(/u);
    expect(controller).toContain('VoiceWorkerClient');
    expect(controller).not.toMatch(/Ffmpeg|PcmFrame|encodePcm|transcribe\(/u);
  });

  it('keeps production autonomous capture and STT behind the worker boundary', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');
    const controller = await readSource('src/adapters/process/voiceWorkerAutoCaptureController.ts');

    expect(implementation).toMatch(/new VoiceWorkerAutoCaptureController/u);
    expect(controller).toContain('VoiceWorkerClient');
    expect(controller).not.toMatch(/Ffmpeg|PcmFrame|encodePcm|\bBuffer\b|ArrayBuffer|\.transcribe\(/u);
  });

  it('keeps the standalone narration tool behind the controller playback boundary', async () => {
    const narrationTool = await readSource('src/adapters/pi/narrationTool.ts');

    expect(narrationTool).toContain('narrateAgent');
    expect(narrationTool).not.toMatch(/modelRegistry|TtsAdapter|\.complete\(|\.speak\(/u);
  });

  it('limits lifecycle narration to the zero-call turn-end fallback', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');
    const controller = await readSource('src/adapters/process/voiceWorkerAutoCaptureController.ts');
    const legacyController = await readSource('src/services/autoCapture.ts');
    const legacyNarration = await readSource('src/services/autonomousNarration.ts');

    expect(`${implementation}\n${controller}`).not.toMatch(
      /NarrationGenerator|VoiceAutoCaptureAdjudicator|resolveAutoCaptureModelContracts|finalizedAssistantIntent/u,
    );
    expect(implementation).not.toMatch(/pi\.on\('(input|agent_start|message_end|tool_execution_end)'/u);
    expect(implementation).toContain("pi.on('tool_execution_start'");
    expect(implementation).toContain("pi.on('turn_end'");
    expect(implementation).toContain("pi.on('agent_settled'");
    expect(implementation).toContain('narrateAttempted');
    expect(legacyController).toBe('');
    expect(legacyNarration).toBe('');
  });

  it('does not restore the removed Runner PTY protocol', async () => {
    const implementation = await readSource('src/adapters/pi/voice.ts');

    expect(implementation).not.toMatch(/runner-pty|createProtocolRuntime/u);
    expect(implementation).not.toMatch(/runCommand:\s*async/u);
  });

  it('prefers the shared Doom config over the package config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-shared-'));
    const agentDirectory = path.join(home, 'agent');
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(agentDirectory, 'doom-voice'), { recursive: true });
    fs.mkdirSync(path.join(home, '.pi', '.doom'), { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(agentDirectory, 'doom-voice', 'config.yaml'), 'voice:\n  language: auto\n');
    fs.writeFileSync(path.join(home, '.pi', '.doom', 'config.yaml'), 'voice:\n  language: en\n');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    vi.stubEnv('PI_PROJECT_TRUST', 'untrusted');

    expect(new PiVoiceConfigService().load(project, home).voice?.language).toBe('en');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads trusted project voice config through the Pi agent directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-trusted-'));
    const agentDirectory = path.join(home, 'agent');
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(agentDirectory, 'doom-voice'), { recursive: true });
    fs.mkdirSync(path.join(project, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(agentDirectory, 'doom-voice', 'config.yaml'),
      'projectTrust: ask\nvoice:\n  language: auto\n',
    );
    fs.writeFileSync(path.join(project, '.doom', 'config.yaml'), 'projectTrust: always\nvoice:\n  language: en\n');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    vi.stubEnv('PI_PROJECT_TRUST', 'trusted');

    expect(new PiVoiceConfigService().load(project, home).voice?.language).toBe('en');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { trust: 'untrusted', projectTrust: 'always' },
    { trust: 'trusted', projectTrust: 'never' },
  ])('ignores project config for $trust hosts with projectTrust $projectTrust', ({ trust, projectTrust }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-untrusted-'));
    const agentDirectory = path.join(home, 'agent');
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(agentDirectory, 'doom-voice'), { recursive: true });
    fs.mkdirSync(path.join(project, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(agentDirectory, 'doom-voice', 'config.yaml'),
      'projectTrust: ask\nvoice:\n  language: auto\n',
    );
    fs.writeFileSync(
      path.join(project, '.doom', 'config.yaml'),
      `projectTrust: ${projectTrust}\nvoice:\n  language: en\n`,
    );
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    vi.stubEnv('PI_PROJECT_TRUST', trust);

    expect(new PiVoiceConfigService().load(project, home).voice?.language).toBe('auto');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ignores malformed project config for an untrusted host', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-malformed-untrusted-'));
    const agentDirectory = path.join(home, 'agent');
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(agentDirectory, 'doom-voice'), { recursive: true });
    fs.mkdirSync(path.join(project, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(agentDirectory, 'doom-voice', 'config.yaml'),
      'projectTrust: ask\nvoice:\n  language: auto\n',
    );
    fs.writeFileSync(path.join(project, '.doom', 'config.yaml'), 'voice: [invalid');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    vi.stubEnv('PI_PROJECT_TRUST', 'untrusted');

    expect(new PiVoiceConfigService().load(project, home).voice?.language).toBe('auto');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('uses an empty safe config when files are absent and surfaces malformed global config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-missing-'));
    const agentDirectory = path.join(home, 'agent');
    const project = path.join(home, 'project');
    fs.mkdirSync(project);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    expect(new PiVoiceConfigService().load(project, home)).toEqual({ projectTrust: 'ask' });

    fs.mkdirSync(path.join(agentDirectory, 'doom-voice'), { recursive: true });
    fs.writeFileSync(path.join(agentDirectory, 'doom-voice', 'config.yaml'), 'voice: [invalid');
    expect(() => new PiVoiceConfigService().load(project, home)).toThrow('Could not parse Doom config');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
