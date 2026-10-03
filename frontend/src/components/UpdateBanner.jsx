import React, { useEffect, useState } from 'react';
import { applyUpdate, isUpdateReady, subscribeUpdateState } from '../lib/pwa.js';

/**
 * A new build is cached and ready. The reload is left to the user so it never
 * interrupts someone mid-transaction.
 */
export default function UpdateBanner() {
  const [ready, setReady] = useState(isUpdateReady());

  useEffect(() => subscribeUpdateState(() => setReady(isUpdateReady())), []);

  if (!ready) return null;

  return (
    <div className="update-banner" role="status">
      <span>A new version of BiasharaBot is ready.</span>
      <button type="button" onClick={applyUpdate}>
        Reload
      </button>
    </div>
  );
}
