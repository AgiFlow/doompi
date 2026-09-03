export const PWA_DATABASE = 'doompi-pwa';
export const PWA_DATABASE_VERSION = 1;
export const PWA_STATE_STORE = 'state';
export const ACTIVE_BUNDLE_KEY = 'active-bundle';
const PLUGIN_COMPOSITION_KEY_PREFIX = 'plugin-composition:';

export interface ActiveBundleState {
  signerPublicKey: string;
  manifestDigest: string;
  revision: number;
  cacheName: string;
}

export interface VerifiedPluginCompositionState {
  compositionId: string;
  signerPublicKey: string;
  manifestDigest: string;
  revision: number;
  cacheName: string;
  verifiedAssetBaseUrl: string;
  lastUsedAt: number;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('The PWA database request failed.')), {
      once: true,
    });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('The PWA transaction aborted.')),
      {
        once: true,
      },
    );
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('The PWA transaction failed.')), {
      once: true,
    });
  });
}

export async function openPwaDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(PWA_DATABASE, PWA_DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(PWA_STATE_STORE)) database.createObjectStore(PWA_STATE_STORE);
  });
  return await requestValue(request);
}

export async function readActiveBundle(): Promise<ActiveBundleState | undefined> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readonly');
    const value = await requestValue(transaction.objectStore(PWA_STATE_STORE).get(ACTIVE_BUNDLE_KEY));
    await transactionDone(transaction);
    return value as ActiveBundleState | undefined;
  } finally {
    database.close();
  }
}

export async function commitActiveBundle(state: ActiveBundleState): Promise<void> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(PWA_STATE_STORE).put(state, ACTIVE_BUNDLE_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearActiveBundle(): Promise<void> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(PWA_STATE_STORE).delete(ACTIVE_BUNDLE_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function pluginCompositionKey(compositionId: string): string {
  return `${PLUGIN_COMPOSITION_KEY_PREFIX}${compositionId}`;
}

export async function readVerifiedPluginComposition(
  compositionId: string,
): Promise<VerifiedPluginCompositionState | undefined> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readonly');
    const value = await requestValue(transaction.objectStore(PWA_STATE_STORE).get(pluginCompositionKey(compositionId)));
    await transactionDone(transaction);
    return value as VerifiedPluginCompositionState | undefined;
  } finally {
    database.close();
  }
}

export async function listVerifiedPluginCompositions(): Promise<VerifiedPluginCompositionState[]> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readonly');
    const store = transaction.objectStore(PWA_STATE_STORE);
    const keys = await requestValue(store.getAllKeys());
    const values = await Promise.all(
      keys
        .filter((key): key is string => typeof key === 'string' && key.startsWith(PLUGIN_COMPOSITION_KEY_PREFIX))
        .map(async (key) => (await requestValue(store.get(key))) as VerifiedPluginCompositionState),
    );
    await transactionDone(transaction);
    return values;
  } finally {
    database.close();
  }
}

export async function commitVerifiedPluginComposition(state: VerifiedPluginCompositionState): Promise<void> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(PWA_STATE_STORE).put(state, pluginCompositionKey(state.compositionId));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearVerifiedPluginComposition(compositionId: string): Promise<void> {
  const database = await openPwaDatabase();
  try {
    const transaction = database.transaction(PWA_STATE_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(PWA_STATE_STORE).delete(pluginCompositionKey(compositionId));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
