/**
 * Minimal IndexedDB helper for the offline outbox and the read-through cache.
 *
 * IndexedDB (not localStorage) because queued voice notes are audio Blobs —
 * localStorage only holds strings and would blow its ~5 MB quota quickly.
 *
 * The schema below is mirrored in public/sw.js, which cannot import this
 * module (classic worker). Keep DB_NAME, DB_VERSION and the store names in
 * sync across both files.
 */

export const DB_NAME = 'biashara-offline';
export const DB_VERSION = 1;
export const OUTBOX_STORE = 'outbox';
export const CACHE_STORE = 'cache';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'clientId' });
        store.createIndex('by_business', 'businessId');
        store.createIndex('by_created', 'createdAt');
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema would block it; drop our handle so the
      // next call reopens cleanly.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

function run(storeName, mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = work(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && result.__request ? result.value : result);
        tx.onabort = tx.onerror = () => reject(tx.error);
      })
  );
}

// Wraps an IDBRequest so its result survives until the transaction completes.
function value(request) {
  const box = { __request: true, value: undefined };
  request.onsuccess = () => {
    box.value = request.result;
  };
  return box;
}

export const idb = {
  getAll(storeName) {
    return run(storeName, 'readonly', (store) => value(store.getAll())).then((rows) => rows || []);
  },

  get(storeName, key) {
    return run(storeName, 'readonly', (store) => value(store.get(key)));
  },

  put(storeName, record) {
    return run(storeName, 'readwrite', (store) => {
      store.put(record);
      return record;
    });
  },

  delete(storeName, key) {
    return run(storeName, 'readwrite', (store) => {
      store.delete(key);
    });
  },

  clear(storeName) {
    return run(storeName, 'readwrite', (store) => {
      store.clear();
    });
  },
};

/* ------------------------------------------------- read-through cache API */

/** Saves a snapshot so the screen can still render with no network. */
export async function saveSnapshot(key, data) {
  try {
    await idb.put(CACHE_STORE, { key, data, savedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[offline] could not save snapshot', key, err);
  }
}

/** @returns {Promise<{data: any, savedAt: string} | null>} */
export async function readSnapshot(key) {
  try {
    const row = await idb.get(CACHE_STORE, key);
    return row ? { data: row.data, savedAt: row.savedAt } : null;
  } catch (err) {
    console.warn('[offline] could not read snapshot', key, err);
    return null;
  }
}
