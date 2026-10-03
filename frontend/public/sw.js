/* eslint-disable no-undef */
/**
 * BiasharaGPT service worker.
 *
 * Written as a classic (non-module) worker so it runs on every browser a duka
 * owner is likely to have, including older Android WebViews and Firefox, which
 * still lack module-worker support.
 *
 * Responsibilities
 *   1. Serve the app shell offline (precache + runtime caching).
 *   2. Keep the last successful ledger/report API responses readable offline.
 *   3. Drain the offline outbox in the background (Background Sync) so voice
 *      notes recorded in a dead spot upload as soon as the phone finds network,
 *      even if the app is closed.
 *
 * The IndexedDB access below deliberately duplicates the small amount of logic
 * in src/lib/idb.js: a classic worker cannot import that module. Both sides
 * must agree on DB_NAME/DB_VERSION/STORE names — change them together.
 */

// Both values are rewritten at build time by the serviceWorkerPrecache plugin
// in vite.config.js: the asset list with this build's hashed files, and the
// version with their content hash so a deploy retires the previous caches.
self.__PRECACHE_ASSETS__ = [];
const VERSION = 'dev';

const SHELL_CACHE = `biashara-shell-${VERSION}`;
const ASSET_CACHE = `biashara-assets-${VERSION}`;
const API_CACHE = `biashara-api-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE, API_CACHE];

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
  // The hashed JS/CSS for this build. Without these the first offline launch
  // would render a blank page: those requests happen before the worker
  // controls the page, so runtime caching never sees them.
  ...(self.__PRECACHE_ASSETS__ || []),
];

const SYNC_TAG = 'biashara-outbox-sync';

/* ------------------------------------------------------------------ install */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll rejects the whole batch if one request fails, which would leave
      // the worker uninstalled; cache entries individually instead.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('biashara-') && !CURRENT_CACHES.includes(k))
          .map((k) => caches.delete(k))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable();
      }
      await self.clients.claim();
    })()
  );
});

/* -------------------------------------------------------------- fetch rules */

const isApiRequest = (url) => url.pathname.startsWith('/api/') || /\/api\//.test(url.href);

const isFontRequest = (url) =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

const isStaticAsset = (request, url) =>
  url.origin === self.location.origin &&
  (['style', 'script', 'image', 'font', 'manifest'].includes(request.destination) ||
    /\.(?:js|css|png|svg|jpe?g|webp|woff2?|ttf|ico|json|webmanifest)$/.test(url.pathname));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes are queued by the app, never cached

  const url = new URL(request.url);
  // Authenticated compliance responses must never enter the offline API cache.
  if (url.pathname.startsWith('/api/compliance') || request.headers.has('Authorization')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (isFontRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  if (isStaticAsset(request, url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
  }
});

// App shell: try the network so deploys are picked up, fall back to the cached
// index.html so a cold launch in a dead spot still boots the app.
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch (err) {
    console.debug('[sw] navigation offline, serving cached shell', err);
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      new Response(
        '<h1>BiasharaGPT is offline</h1><p>Open the app once while online to install it for offline use.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  // Precached build assets live in the shell cache, so fall back to a lookup
  // across every cache before deciding this request is a miss.
  const cached = (await cache.match(request)) || (await caches.match(request));

  const update = fetch(request)
    .then((response) => {
      // Opaque (cross-origin font) responses have status 0 but are still usable.
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await update;
  if (fresh) return fresh;
  return new Response('', { status: 504, statusText: 'Offline and not cached' });
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    console.debug('[sw] API request failed, falling back to cache', request.url, err);
    const cached = await cache.match(request);
    if (cached) {
      // Tag it so the UI can say "showing saved data".
      const headers = new Headers(cached.headers);
      headers.set('X-Biashara-From-Cache', '1');
      return new Response(await cached.blob(), {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
    return new Response(JSON.stringify({ error: 'offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/* ----------------------------------------------------- outbox (IndexedDB) */

const DB_NAME = 'biashara-offline';
const DB_VERSION = 1;
const OUTBOX_STORE = 'outbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'clientId' });
        store.createIndex('by_business', 'businessId');
        store.createIndex('by_created', 'createdAt');
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

async function readPending() {
  const db = await openDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const request = tx.objectStore(OUTBOX_STORE).getAll();
    const items = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    return items
      .filter((item) => item.status !== 'failed')
      .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } finally {
    db.close();
  }
}

async function writeItem(item) {
  const db = await openDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).put(item);
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function deleteItem(clientId) {
  const db = await openDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).delete(clientId);
    await txDone(tx);
  } finally {
    db.close();
  }
}

// Duplicate posts are harmless: the backend treats client_id as an idempotency
// key and returns the already-stored entry instead of creating a second one.
async function uploadItem(item) {
  const base = item.apiBase;
  if (item.kind === 'voice') {
    const form = new FormData();
    form.append('audio', item.audio, item.fileName || 'voice_note.webm');
    form.append('businessId', item.businessId);
    form.append('clientId', item.clientId);
    form.append('occurredAt', item.createdAt);
    return fetch(`${base}/entries/voice`, { method: 'POST', body: form });
  }
  return fetch(`${base}/entries/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: item.text,
      businessId: item.businessId,
      clientId: item.clientId,
      occurredAt: item.createdAt,
    }),
  });
}

const backoffMs = (attempts) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

async function flushOutbox() {
  const pending = await readPending();
  let synced = 0;
  let remaining = pending.length;

  for (const item of pending) {
    let response;
    try {
      response = await uploadItem(item);
    } catch (err) {
      // Still offline or the request died mid-flight: keep it and stop early,
      // there is no point hammering the rest of the queue.
      console.debug('[sw] outbox upload could not reach the server', err);
      break;
    }

    if (response.ok) {
      await deleteItem(item.clientId);
      synced += 1;
      remaining -= 1;
      continue;
    }

    const attempts = (item.attempts || 0) + 1;
    if (response.status >= 400 && response.status < 500) {
      // The server understood us and refused: retrying will not help.
      await writeItem({
        ...item,
        attempts,
        status: 'failed',
        lastError: `Server rejected this entry (${response.status})`,
      });
      remaining -= 1;
    } else {
      await writeItem({
        ...item,
        attempts,
        lastError: `Upload failed (${response.status})`,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      });
    }
  }

  if (synced > 0) await notifyClients({ type: 'OUTBOX_SYNCED', synced, remaining });
  return { synced, remaining };
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage(message);
}

/* --------------------------------------------------------- sync + messages */

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    // Rejecting here asks the browser to retry the sync later.
    event.waitUntil(
      flushOutbox().then(({ remaining }) => {
        if (remaining > 0) throw new Error('Outbox not fully drained');
      })
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'FLUSH_OUTBOX') {
    event.waitUntil(flushOutbox());
  }
});
