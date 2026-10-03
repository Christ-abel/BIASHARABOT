// Single source of truth for the backend URL, shared by the UI and the
// offline outbox. Override at build time with VITE_API_BASE.
export const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.DEV ? 'http://localhost:5000/api' : 'https://biasharagpt.onrender.com/api');

/** True when the browser reports no connectivity (a hint, never a guarantee). */
export const isOffline = () =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Distinguishes "the request never reached the server" from "the server said
 * no". Only the former should push an entry into the offline outbox.
 */
export const isNetworkError = (error) =>
  error instanceof TypeError || error?.name === 'AbortError' || isOffline();
