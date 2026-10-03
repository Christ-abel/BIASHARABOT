import { useCallback, useEffect, useRef, useState } from 'react';
import {
  flushOutbox,
  listOutbox,
  listenForServiceWorkerSync,
  requestBackgroundSync,
  subscribeOutbox,
} from '../lib/outbox.js';

const RETRY_INTERVAL_MS = 60_000;

/**
 * Connectivity + offline queue state for the UI.
 *
 * Flush triggers, in order of usefulness on a patchy mobile network:
 *   - the browser's `online` event (the common case: walking into coverage)
 *   - returning to the app (tab focus / visibility), because `online` can be
 *     missed or lie while the phone was asleep
 *   - a slow poll, for when `online` never fires but data actually works
 *   - Background Sync from the service worker, even with the app closed
 *
 * @param {string | undefined} businessId
 * @param {{ onSynced?: (count: number) => void }} options onSynced runs after
 *   entries reach the server, so the caller can refetch the ledger.
 */
export function useOfflineSync(businessId, { onSynced } = {}) {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );
  const [queue, setQueue] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Kept in refs so the effect below can stay mounted for the session instead
  // of tearing its listeners down on every render.
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const businessIdRef = useRef(businessId);
  businessIdRef.current = businessId;

  const refresh = useCallback(async () => {
    const items = await listOutbox(businessIdRef.current);
    setQueue(items);
    return items;
  }, []);

  const sync = useCallback(
    async ({ force = false, silent = false } = {}) => {
      if (!businessIdRef.current) return null;
      if (!silent) setSyncing(true);
      try {
        const result = await flushOutbox({ businessId: businessIdRef.current, force });
        await refresh();
        if (result?.synced > 0) {
          setLastSyncedAt(new Date().toISOString());
          onSyncedRef.current?.(result.synced);
        }
        return result;
      } finally {
        if (!silent) setSyncing(false);
      }
    },
    [refresh]
  );

  // Keep the queue in step with writes from anywhere in the app.
  useEffect(() => subscribeOutbox(() => { refresh(); }), [refresh]);

  useEffect(() => {
    refresh();
  }, [businessId, refresh]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      requestBackgroundSync();
      sync({ force: true, silent: true });
    };
    const goOffline = () => setOnline(false);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setOnline(navigator.onLine !== false);
      if (navigator.onLine !== false) sync({ silent: true });
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    const timer = setInterval(() => {
      if (navigator.onLine !== false) sync({ silent: true });
    }, RETRY_INTERVAL_MS);

    const stopSwListener = listenForServiceWorkerSync(({ synced }) => {
      setLastSyncedAt(new Date().toISOString());
      refresh();
      if (synced > 0) onSyncedRef.current?.(synced);
    });

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(timer);
      stopSwListener();
    };
  }, [refresh, sync]);

  const pending = queue.filter((item) => item.status !== 'failed');
  const failed = queue.filter((item) => item.status === 'failed');

  return {
    online,
    queue,
    pending,
    failed,
    pendingCount: pending.length,
    failedCount: failed.length,
    syncing,
    lastSyncedAt,
    sync,
    refresh,
  };
}
