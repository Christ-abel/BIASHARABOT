/**
 * Service worker registration and "add to home screen" plumbing.
 *
 * Imported from main.jsx so the beforeinstallprompt event is captured before
 * React mounts — the browser fires it once, early, and discards it if nobody
 * is listening.
 */

let installPrompt = null;
let updateReadyWorker = null;
let applyingUpdate = false;
const installListeners = new Set();
const updateListeners = new Set();

const notify = (set) => {
  for (const listener of set) listener();
};

/** True when the app is running installed, rather than in a browser tab. */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true // iOS Safari
  );
}

/** iOS has no install prompt API; those users need the Share-sheet steps. */
export function isIos() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac, but with touch points.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export const canInstall = () => installPrompt !== null;

export function subscribeInstallState(listener) {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

export function subscribeUpdateState(listener) {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export const isUpdateReady = () => updateReadyWorker !== null;

/** Shows the browser's install dialog. @returns {Promise<boolean>} accepted */
export async function promptInstall() {
  if (!installPrompt) return false;
  const prompt = installPrompt;
  installPrompt = null;
  notify(installListeners);

  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === 'accepted';
}

/** Activates a downloaded update and reloads into it. */
export function applyUpdate() {
  if (!updateReadyWorker) {
    window.location.reload();
    return;
  }
  applyingUpdate = true;
  updateReadyWorker.postMessage({ type: 'SKIP_WAITING' });
  updateReadyWorker = null;
  notify(updateListeners);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the event so the app can offer install on its own button instead of
    // Chrome's mini-infobar.
    event.preventDefault();
    installPrompt = event;
    notify(installListeners);
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    notify(installListeners);
  });
}

/**
 * Asks the browser not to evict our storage under pressure. Queued voice notes
 * are audio blobs in IndexedDB — the one thing here that must not be cleared
 * before it has been uploaded.
 */
export async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    console.info('[pwa] service workers unsupported — running online-only');
    return;
  }

  // Registering after load keeps the first paint free of the extra request on
  // the slow connections this app is built for.
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      const track = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            updateReadyWorker = worker;
            notify(updateListeners);
          }
        });
      };

      if (registration.waiting && navigator.serviceWorker.controller) {
        updateReadyWorker = registration.waiting;
        notify(updateListeners);
      }
      registration.addEventListener('updatefound', () => track(registration.installing));

      // Ask for periodic background sync where it exists (Chrome on Android):
      // lets queued entries upload without the app being opened at all.
      if ('periodicSync' in registration) {
        try {
          const status = await navigator.permissions?.query({ name: 'periodic-background-sync' });
          if (!status || status.state === 'granted') {
            await registration.periodicSync.register('biashara-outbox-sync', {
              minInterval: 60 * 60 * 1000,
            });
          }
        } catch {
          /* not supported or not permitted; foreground sync still applies */
        }
      }
    } catch (err) {
      console.error('[pwa] service worker registration failed', err);
    }
  });

  // Only reload for an update the user accepted. The worker also claims clients
  // on its very first activation, and reloading there would be pointless churn.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applyingUpdate) return;
    applyingUpdate = false;
    window.location.reload();
  });
}
