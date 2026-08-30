export const PWA_DATABASE = 'doompi-pwa';
export const PWA_DATABASE_VERSION = 1;
export const PWA_STATE_STORE = 'state';
export const ACTIVE_BUNDLE_KEY = 'active-bundle';

export interface ActiveBundleState {
  signerPublicKey: string;
  manifestDigest: string;
  revision: number;
  cacheName: string;
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
