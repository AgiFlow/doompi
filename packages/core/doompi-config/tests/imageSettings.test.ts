import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_MAX_DIMENSION,
  loadPiImageSettings,
  MIN_IMAGE_MAX_DIMENSION,
  parsePiImageSettings,
  piImageSettingsPath,
  savePiImageSettings,
} from '../src/exports/config/piConfig.ts';

let home: string;

function writeSettings(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readSettings(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-image-settings-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pi image settings', () => {
  it('treats an absent images block as Pi does: resizing on, at Pi is own cap', () => {
    expect(parsePiImageSettings({})).toEqual({ autoResize: true, maxDimension: DEFAULT_IMAGE_MAX_DIMENSION });
  });

  it('ignores values a hand-written file can hold but the resize pass cannot use', () => {
    expect(parsePiImageSettings({ images: { autoResize: 'no', maxDimension: 'big' } })).toEqual({
      autoResize: true,
      maxDimension: DEFAULT_IMAGE_MAX_DIMENSION,
    });
    expect(parsePiImageSettings({ images: null })).toEqual({
      autoResize: true,
      maxDimension: DEFAULT_IMAGE_MAX_DIMENSION,
    });
  });

  it('clamps a cap Pi would undo, and one that would leave nothing readable', () => {
    expect(parsePiImageSettings({ images: { maxDimension: 8000 } }).maxDimension).toBe(DEFAULT_IMAGE_MAX_DIMENSION);
    expect(parsePiImageSettings({ images: { maxDimension: 4 } }).maxDimension).toBe(MIN_IMAGE_MAX_DIMENSION);
  });

  it('reads the canonical user file over the legacy one', () => {
    writeSettings(path.join(home, '.pi', 'settings.json'), { images: { autoResize: false, maxDimension: 800 } });
    writeSettings(piImageSettingsPath(home), { images: { maxDimension: 1200 } });

    expect(loadPiImageSettings(home)).toEqual({ autoResize: false, maxDimension: 1200 });
  });

  it('writes into a settings file that does not exist yet', () => {
    expect(savePiImageSettings({ autoResize: false, maxDimension: 1024 }, home)).toEqual({
      autoResize: false,
      maxDimension: 1024,
    });
    expect(readSettings(piImageSettingsPath(home))).toEqual({ images: { autoResize: false, maxDimension: 1024 } });
  });

  it('leaves every other Pi setting, and every other image key, alone', () => {
    writeSettings(piImageSettingsPath(home), {
      theme: 'doom',
      images: { autoResize: false, somethingPiAdded: 'keep me' },
    });

    savePiImageSettings({ maxDimension: 900 }, home);

    expect(readSettings(piImageSettingsPath(home))).toEqual({
      theme: 'doom',
      images: { autoResize: false, somethingPiAdded: 'keep me', maxDimension: 900 },
    });
  });
});
