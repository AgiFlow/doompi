import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStoredTheme, availableThemes, selectTheme, themeStore } from '../../src/web/stores/themeStore.ts';

interface FakeStorage extends Storage {
  readonly values: Map<string, string>;
}

function fakeStorage(initial: Readonly<Record<string, string>> = {}): FakeStorage {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function fakeDocumentRoot(): {
  readonly attributes: Map<string, string>;
  readonly properties: Map<string, string>;
  readonly root: HTMLElement;
} {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const root = {
    style: {
      colorScheme: '',
      setProperty: (name: string, value: string) => void properties.set(name, value),
    },
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
  } as unknown as HTMLElement;
  return { attributes, properties, root };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function installBrowser(storage: Storage, root: HTMLElement): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
}

function restoreGlobal(name: 'window' | 'document', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

describe('theme store', () => {
  beforeEach(() => {
    restoreGlobal('window', originalWindow);
    restoreGlobal('document', originalDocument);
  });

  afterEach(() => {
    restoreGlobal('window', originalWindow);
    restoreGlobal('document', originalDocument);
  });

  it('applies the default when storage is unavailable', () => {
    const page = fakeDocumentRoot();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: page.root } });

    applyStoredTheme();

    expect(themeStore.state.name).toBe(availableThemes()[0]?.name);
    expect(page.attributes.get('data-theme')).toBe(themeStore.state.name);
    expect(page.properties.size).toBeGreaterThan(0);
  });

  it('applies and remembers a shipped theme', () => {
    const selected = availableThemes()[1] ?? availableThemes()[0]!;
    const storage = fakeStorage();
    const page = fakeDocumentRoot();
    installBrowser(storage, page.root);

    selectTheme(selected.name);

    expect(themeStore.state.name).toBe(selected.name);
    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()]).toEqual([selected.name]);
    expect(page.attributes.get('data-theme')).toBe(selected.name);

    applyStoredTheme();
    expect(themeStore.state.name).toBe(selected.name);
  });

  it('forgets an unknown stored theme and ignores an unknown selection', () => {
    const storage = fakeStorage({ 'doompi.web.theme': 'missing-theme' });
    const page = fakeDocumentRoot();
    installBrowser(storage, page.root);

    applyStoredTheme();
    const defaultName = themeStore.state.name;
    expect(storage.values.size).toBe(0);

    selectTheme('missing-theme');
    expect(themeStore.state.name).toBe(defaultName);
    expect(storage.values.size).toBe(0);
  });

  it('still switches themes when local storage access is denied', () => {
    const selected = availableThemes()[1] ?? availableThemes()[0]!;
    const page = fakeDocumentRoot();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.defineProperty({}, 'localStorage', {
        get: () => {
          throw new Error('denied');
        },
      }),
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: page.root } });

    expect(() => selectTheme(selected.name)).not.toThrow();
    expect(themeStore.state.name).toBe(selected.name);
  });
});
