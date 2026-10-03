import React, { useEffect, useRef, useState } from 'react';
import { API_BASE, isOffline } from '../lib/api.js';
import { formatKsh, timeAgo } from '../lib/format.js';

const emptyManual = { item: '', qty: '', unit_cost: '', supplier: '' };

const emptyRow = () => ({ item: '', qty: '', unit_cost: '', total: '' });

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Stock tab: upload a supplier receipt (Gemini reads it), review the lines,
 * or type a purchase in when there is no slip. Nothing is written until the
 * owner confirms — phone photos are often blurry, and a bad total would
 * poison the weekly profit figures.
 */
export default function StockPanel({ business, online, onSaved, onError, onSuccess }) {
  const fileInputRef = useRef(null);
  const [lots, setLots] = useState([]);
  const [loadingLots, setLoadingLots] = useState(false);

  const [parsing, setParsing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [fileName, setFileName] = useState('');
  const [review, setReview] = useState(null);
  const [saving, setSaving] = useState(false);

  const [manual, setManual] = useState(emptyManual);
  const [savingManual, setSavingManual] = useState(false);

  const fetchLots = async () => {
    if (!business) return;
    setLoadingLots(true);
    try {
      const response = await fetch(`${API_BASE}/stock?businessId=${business.id}`);
      if (!response.ok) throw new Error('Could not load stock');
      setLots(await response.json());
    } catch (err) {
      console.warn('Stock list failed:', err);
    } finally {
      setLoadingLots(false);
    }
  };

  useEffect(() => {
    fetchLots();
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // business.id is the only identity we care about; preview cleanup runs on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id]);

  const resetReview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFileName('');
    setReview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (file) => {
    if (!file) return;
    onError(null);
    onSuccess(null);

    if (isOffline() || !online) {
      onError('Reading a receipt needs network — type the stock in below while you are offline.');
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
    setFileName(file.name);

    setParsing(true);
    try {
      const formData = new FormData();
      formData.append('receipt', file);
      formData.append('businessId', business.id);

      const response = await fetch(`${API_BASE}/stock/receipt/parse`, {
        method: 'POST',
        body: formData
      });
      const data = await response.json();

      if (!response.ok) {
        onError(data.error || 'Could not read this receipt');
        setReview(null);
        return;
      }

      setReview({
        supplier: data.supplier || '',
        date: data.date ? String(data.date).slice(0, 10) : '',
        rows: data.line_items.map((row) => ({
          item: row.item,
          qty: String(row.qty),
          unit_cost: String(row.unit_cost),
          total: String(row.total)
        })),
        rejected: data.rejected || [],
        mock: Boolean(data.mock)
      });
    } catch {
      onError('Connection to the receipt reader failed');
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (index, field, value) => {
    setReview((current) => {
      if (!current) return current;
      const rows = current.rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, [field]: value };
        if (field === 'qty' || field === 'unit_cost') {
          const qty = Number(next.qty);
          const cost = Number(next.unit_cost);
          next.total = Number.isFinite(qty) && Number.isFinite(cost)
            ? String(roundMoney(qty * cost))
            : '';
        }
        return next;
      });
      return { ...current, rows };
    });
  };

  const removeRow = (index) => {
    setReview((current) => current
      ? { ...current, rows: current.rows.filter((_, i) => i !== index) }
      : current);
  };

  const addRow = () => {
    setReview((current) => current
      ? { ...current, rows: [...current.rows, emptyRow()] }
      : current);
  };

  const handleConfirm = async (event) => {
    event.preventDefault();
    if (!review) return;

    onError(null);
    onSuccess(null);
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/stock/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          source: 'receipt',
          supplier: review.supplier,
          date: review.date || undefined,
          items: review.rows
        })
      });
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || 'Could not save this receipt');
        return;
      }
      onSuccess(`Saved ${data.count} stock ${data.count === 1 ? 'item' : 'items'} from the receipt.`);
      resetReview();
      fetchLots();
      onSaved?.();
    } catch {
      onError('Connection failed while saving stock');
    } finally {
      setSaving(false);
    }
  };

  const handleManual = async (event) => {
    event.preventDefault();
    onError(null);
    onSuccess(null);

    if (isOffline() || !online) {
      onError('Saving stock needs network so the weekly report stays in sync.');
      return;
    }

    setSavingManual(true);
    try {
      const response = await fetch(`${API_BASE}/stock/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          item: manual.item,
          qty: manual.qty,
          unit_cost: manual.unit_cost,
          supplier: manual.supplier
        })
      });
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || 'Could not save this stock entry');
        return;
      }
      onSuccess(`Logged stock: ${manual.item} (${manual.qty} × ${formatKsh(manual.unit_cost)})`);
      setManual(emptyManual);
      fetchLots();
      onSaved?.();
    } catch {
      onError('Connection failed while saving stock');
    } finally {
      setSavingManual(false);
    }
  };

  const manualTotal = Number(manual.qty) * Number(manual.unit_cost);
  const showManualTotal = Number.isFinite(manualTotal) && manualTotal > 0;

  return (
    <div className="stock-panel">
      <div className="logger-card">
        <h3>Upload a supplier receipt</h3>
        <p className="stock-lead">
          Photograph the slip or pick a PDF. Gemini reads the lines — you check
          them before anything is saved.
        </p>

        {!online && (
          <p className="offline-capture-note">
            Receipt reading needs network. Type the stock in below and it is
            written the next time you are online.
          </p>
        )}

        <label className={`stock-dropzone ${parsing ? 'is-busy' : ''}`}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            disabled={parsing || saving || !online}
            onChange={(event) => handleFile(event.target.files?.[0])}
          />
          <span className="stock-dropzone-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </span>
          <strong>{parsing ? 'Reading receipt…' : 'Tap to take a photo or choose a file'}</strong>
          <span>JPG, PNG, WebP or PDF · max 8 MB</span>
        </label>

        {previewUrl && (
          <img className="stock-preview" src={previewUrl} alt="Uploaded receipt preview" />
        )}
        {!previewUrl && fileName && (
          <p className="stock-filename">Selected: {fileName}</p>
        )}
      </div>

      {review && (
        <form className="logger-card stock-review" onSubmit={handleConfirm}>
          <h3>Review before saving</h3>
          <p className="stock-lead">
            Correct any line Gemini misread. A total that does not add up will
            be rejected.
          </p>

          {review.mock && (
            <p className="offline-capture-note">
              Mock mode — sample line items (no Gemini charge). Swap in a real
              key to read an actual photo.
            </p>
          )}

          {review.rejected.length > 0 && (
            <div className="error-message">
              Skipped {review.rejected.length} unreadable{' '}
              {review.rejected.length === 1 ? 'line' : 'lines'}. Add them by hand
              if they belong on this slip.
            </div>
          )}

          <div className="stock-meta-grid">
            <div className="form-group">
              <label>Supplier</label>
              <input
                className="form-input"
                value={review.supplier}
                onChange={(e) => setReview({ ...review, supplier: e.target.value })}
                placeholder="e.g. Nairobi Wholesalers"
              />
            </div>
            <div className="form-group">
              <label>Receipt date</label>
              <input
                type="date"
                className="form-input"
                value={review.date}
                onChange={(e) => setReview({ ...review, date: e.target.value })}
              />
            </div>
          </div>

          <div className="stock-lines">
            {review.rows.map((row, index) => (
              <div className="stock-line" key={`row-${index}`}>
                <div className="form-group">
                  <label>Item</label>
                  <input
                    className="form-input"
                    value={row.item}
                    onChange={(e) => updateRow(index, 'item', e.target.value)}
                    required
                  />
                </div>
                <div className="stock-line-nums">
                  <div className="form-group">
                    <label>Qty</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="any"
                      value={row.qty}
                      onChange={(e) => updateRow(index, 'qty', e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Unit cost</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="any"
                      value={row.unit_cost}
                      onChange={(e) => updateRow(index, 'unit_cost', e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Total</label>
                    <input className="form-input mono" value={row.total} readOnly tabIndex={-1} />
                  </div>
                </div>
                <button
                  type="button"
                  className="stock-remove"
                  onClick={() => removeRow(index)}
                  disabled={review.rows.length === 1}
                >
                  Remove line
                </button>
              </div>
            ))}
          </div>

          <button type="button" className="stock-add-line" onClick={addRow}>
            + Add another item
          </button>

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={resetReview} disabled={saving}>
              Discard
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || review.rows.length === 0}>
              {saving ? 'Saving…' : 'Save stock'}
            </button>
          </div>
        </form>
      )}

      <div className="divider-text">OR TYPE STOCK IN</div>

      <form className="logger-card" onSubmit={handleManual}>
        <h3>No receipt? Type it in</h3>
        <p className="stock-lead">
          Item, quantity and what you paid per unit. This writes a purchase on
          the ledger so the weekly totals stay honest.
        </p>

        <div className="form-group">
          <label>Item</label>
          <input
            className="form-input"
            placeholder="e.g. Sugar 2kg"
            value={manual.item}
            onChange={(e) => setManual({ ...manual, item: e.target.value })}
            required
            disabled={savingManual}
          />
        </div>

        <div className="stock-line-nums">
          <div className="form-group">
            <label>Quantity</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="any"
              placeholder="10"
              value={manual.qty}
              onChange={(e) => setManual({ ...manual, qty: e.target.value })}
              required
              disabled={savingManual}
            />
          </div>
          <div className="form-group">
            <label>Unit cost (KSh)</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="any"
              placeholder="280"
              value={manual.unit_cost}
              onChange={(e) => setManual({ ...manual, unit_cost: e.target.value })}
              required
              disabled={savingManual}
            />
          </div>
        </div>

        <div className="form-group">
          <label>Supplier (optional)</label>
          <input
            className="form-input"
            placeholder="e.g. Gikomba wholesaler"
            value={manual.supplier}
            onChange={(e) => setManual({ ...manual, supplier: e.target.value })}
            disabled={savingManual}
          />
        </div>

        {showManualTotal && (
          <p className="stock-running-total mono">
            Line total {formatKsh(manualTotal)}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={savingManual || !online}>
          {savingManual ? 'Saving…' : 'Save stock entry'}
        </button>
      </form>

      <div className="ledger-section">
        <div className="section-header">
          <h3>Recent stock purchases</h3>
          <button type="button" className="stock-refresh" onClick={fetchLots}>
            Refresh
          </button>
        </div>

        {loadingLots && lots.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0' }}>
            <div className="loading-spinner" />
          </div>
        ) : lots.length === 0 ? (
          <p className="stock-empty">
            No stock recorded yet. Upload a receipt or type the first purchase
            above — sales will then show a real margin on the till slip.
          </p>
        ) : (
          <div className="ledger-list">
            {lots.map((lot) => (
              <div className="ledger-item purchase" key={lot._id}>
                <div className="item-details">
                  <span className="item-name">{lot.item}</span>
                  <div className="item-meta">
                    <span>{lot.qty} × {formatKsh(lot.unit_cost)}</span>
                    <span>•</span>
                    <span className={`badge badge-${lot.source}`}>{lot.source}</span>
                    {lot.supplier ? (
                      <>
                        <span>•</span>
                        <span>{lot.supplier}</span>
                      </>
                    ) : null}
                    <span>•</span>
                    <span>{timeAgo(lot.purchase_date || lot.created_at)}</span>
                  </div>
                </div>
                <div className="item-amount-area">
                  <span className="item-amount mono">{formatKsh(lot.total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
