/**
 * The offline outbox: transactions captured with no usable network.
 *
 * A duka owner can record a voice note or type an entry in a dead spot; it is
 * stored in IndexedDB (audio Blob and all) and uploaded the moment a network
 * appears — by this module while the app is open, or by the service worker's
 * Background Sync if the app was closed in the meantime.
 *
 * Every queued item carries a clientId, which the backend uses as an
 * idempotency key, so a double upload (app and service worker racing, or a
 * reply lost after the server committed) can never create a duplicate sale.
 */

import { API_BASE } from './api.js';
import { idb, OUTBOX_STORE } from './idb.js';
import { parseTransactionLocally } from './localParse.js';

const SYNC_TAG = 'biashara-outbox-sync';
const MAX_BACKOFF_MS = 30 * 60_000;

const listeners = new Set();
let flushing = null;

function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `bg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const backoffMs = (attempts) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

/** Subscribe to outbox changes. @returns {() => void} unsubscribe */
export function subscribeOutbox(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[outbox] listener failed', err);
    }
  }
}

/** All queued items for a business, oldest first. */
export async function listOutbox(businessId) {
  try {
    const rows = await idb.getAll(OUTBOX_STORE);
    return rows
      .filter((row) => !businessId || row.businessId === businessId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } catch (err) {
    console.warn('[outbox] could not read queue', err);
    return [];
  }
}

async function enqueue(item) {
  const record = {
    clientId: newClientId(),
    apiBase: API_BASE,
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
    lastError: null,
    nextAttemptAt: null,
    ...item,
  };
  await idb.put(OUTBOX_STORE, record);
  emit();
  requestBackgroundSync();
  return record;
}

/** Queues a typed entry, with a provisional on-device parse for the totals. */
export function enqueueTextEntry({ businessId, text }) {
  return enqueue({
    kind: 'text',
    businessId,
    text,
    provisional: parseTransactionLocally(text),
  });
}

/**
 * Queues a voice note. There is no provisional figure: transcription needs
 * Gemini, so the amount stays unknown until the note uploads.
 */
export function enqueueVoiceEntry({ businessId, audio, mimeType, durationSec }) {
  return enqueue({
    kind: 'voice',
    businessId,
    audio,
    mimeType: mimeType || audio?.type || 'audio/webm',
    fileName: 'voice_note.webm',
    durationSec: durationSec || 0,
    provisional: null,
  });
}

/** Drops a queued item — used for entries the server permanently rejected. */
export async function discardOutboxItem(clientId) {
  await idb.delete(OUTBOX_STORE, clientId);
  emit();
}

/** Clears a permanent failure so the next flush tries the item again. */
export async function retryOutboxItem(clientId) {
  const item = await idb.get(OUTBOX_STORE, clientId);
  if (!item) return;
  await idb.put(OUTBOX_STORE, {
    ...item,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  emit();
  flushOutbox({ businessId: item.businessId });
}

function upload(item) {
  if (item.kind === 'voice') {
    const form = new FormData();
    form.append('audio', item.audio, item.fileName || 'voice_note.webm');
    form.append('businessId', item.businessId);
    form.append('clientId', item.clientId);
    form.append('occurredAt', item.createdAt);
    return fetch(`${API_BASE}/entries/voice`, { method: 'POST', body: form });
  }

  return fetch(`${API_BASE}/entries/text`, {
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

/**
 * Uploads everything that is due. Safe to call often: concurrent calls share
 * one in-flight pass.
 *
 * @param {{businessId?: string, force?: boolean}} options force ignores the
 *   retry backoff (used by the "Sync now" button).
 * @returns {Promise<{synced: number, remaining: number, failed: number, stalled: boolean}>}
 */
export function flushOutbox({ businessId, force = false } = {}) {
  if (flushing) return flushing;
  flushing = runFlush({ businessId, force }).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush({ businessId, force }) {
  const all = await listOutbox(businessId);
  const now = Date.now();
  const due = all.filter(
    (item) =>
      item.status !== 'failed' &&
      (force || !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
  );

  let synced = 0;
  let stalled = false;

  for (const item of due) {
    let response;
    try {
      response = await upload(item);
    } catch (err) {
      // The request never reached the server. Leave the item queued and stop:
      // the rest of the queue would fail the same way.
      console.debug('[outbox] upload could not reach the server', err);
      await idb.put(OUTBOX_STORE, {
        ...item,
        attempts: (item.attempts || 0) + 1,
        lastError: 'No network — still waiting to upload',
      });
      stalled = true;
      break;
    }

    if (response.ok) {
      await idb.delete(OUTBOX_STORE, item.clientId);
      synced += 1;
      continue;
    }

    const attempts = (item.attempts || 0) + 1;
    if (response.status >= 400 && response.status < 500) {
      // The server understood the entry and refused it (e.g. 422: Gemini could
      // not find an amount). Retrying cannot fix that, so surface it instead.
      let message = `Server rejected this entry (${response.status})`;
      try {
        const body = await response.json();
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body; the status-based message is good enough
      }
      await idb.put(OUTBOX_STORE, { ...item, attempts, status: 'failed', lastError: message });
    } else {
      await idb.put(OUTBOX_STORE, {
        ...item,
        attempts,
        lastError: `Upload failed (${response.status}) — will retry`,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      });
    }
  }

  const left = await listOutbox(businessId);
  emit();

  return {
    synced,
    remaining: left.filter((item) => item.status !== 'failed').length,
    failed: left.filter((item) => item.status === 'failed').length,
    stalled,
  };
}

/**
 * Asks the browser to finish the upload in the background, so a queued voice
 * note still lands even if the owner closes the app before finding network.
 * Silently unavailable on iOS Safari, where the in-app flush is the fallback.
 */
export function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then((registration) => registration.sync?.register(SYNC_TAG))
    .catch(() => {
      /* Background Sync unsupported or denied — the app retries in foreground */
    });
}

/** Lets the service worker tell us it drained the queue while we were idle. */
export function listenForServiceWorkerSync(onSynced) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return () => {};

  const handler = (event) => {
    if (event.data?.type === 'OUTBOX_SYNCED') {
      emit();
      onSynced?.(event.data);
    }
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
