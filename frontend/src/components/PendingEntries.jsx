import React from 'react';
import { formatDuration, formatKsh, timeAgo } from '../lib/format.js';

/**
 * Entries captured offline that have not reached the server yet.
 *
 * Voice notes show no amount on purpose: transcription and pricing happen on
 * the server, so inventing a figure here would be a lie. Typed entries show
 * the on-device estimate, marked "≈" until the server's parse replaces it.
 */
export default function PendingEntries({ items, failed, onRetry, onDiscard, masked = false }) {
  if (!items.length && !failed.length) return null;

  return (
    <div className="pending-section">
      {items.length > 0 && (
        <>
          <div className="pending-header">
            <h3>Waiting to sync</h3>
            <span className="pending-count">{items.length}</span>
          </div>
          <p className="pending-note">
            Saved on this phone. They upload and reconcile against M-Pesa automatically once you
            have network — you can close the app.
          </p>

          <div className="pending-list">
            {items.map((item) => (
              <div className="pending-item" key={item.clientId}>
                <div className="pending-item-main">
                  <span className="pending-item-name">
                    {item.kind === 'voice'
                      ? `Voice note (${formatDuration(item.durationSec)})`
                      : item.provisional?.item || item.text}
                  </span>
                  <div className="pending-item-meta">
                    <span className="pending-kind">{item.kind === 'voice' ? 'Voice' : 'Typed'}</span>
                    <span>•</span>
                    <span>{timeAgo(item.createdAt)}</span>
                    {item.attempts > 0 && (
                      <>
                        <span>•</span>
                        <span>{item.attempts === 1 ? '1 attempt' : `${item.attempts} attempts`}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="pending-item-amount">
                  {item.provisional ? (
                    <span className={`mono provisional ${masked ? 'privacy-blurred' : ''}`} title="On-device estimate — confirmed when it syncs">
                      ≈ {formatKsh(item.provisional.total)}
                    </span>
                  ) : (
                    <span className="awaiting">Amount after sync</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {failed.length > 0 && (
        <div className="failed-list">
          <div className="pending-header">
            <h3>Could not be saved</h3>
            <span className="pending-count failed">{failed.length}</span>
          </div>
          <p className="pending-note">
            The server could not read these. Retry them, or discard and log the transaction again.
          </p>

          {failed.map((item) => (
            <div className="pending-item failed" key={item.clientId}>
              <div className="pending-item-main">
                <span className="pending-item-name">
                  {item.kind === 'voice'
                    ? `Voice note (${formatDuration(item.durationSec)})`
                    : item.text}
                </span>
                <div className="pending-item-meta">
                  <span>{item.lastError || 'Rejected by server'}</span>
                </div>
              </div>

              <div className="pending-item-actions">
                <button type="button" onClick={() => onRetry(item.clientId)}>
                  Retry
                </button>
                <button type="button" className="discard" onClick={() => onDiscard(item.clientId)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
