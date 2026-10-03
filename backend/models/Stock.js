import mongoose from 'mongoose';

/**
 * A stock *purchase* — what the shop bought, at what unit cost.
 *
 * This is not a running inventory count. Sales do not decrement qty here;
 * remaining stock-on-hand is a later problem. We keep the purchase so that
 * weekly item-level gross profit can look up a real cost of goods, instead of
 * guessing from the sale price.
 *
 * Saving a Stock row always creates a matching purchase Entry so the existing
 * weekly cash-basis totals (revenue − purchases − expenses − fees) stay
 * consistent with the ledger the owner already knows.
 */
const stockSchema = new mongoose.Schema({
  business_id: { type: String, required: true, index: true },
  item: { type: String, required: true, trim: true },
  qty: { type: Number, required: true, min: 0 },
  unit_cost: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  supplier: { type: String, trim: true, default: '' },
  // The date printed on the receipt when we have one; otherwise the save time.
  purchase_date: { type: Date, default: Date.now },
  source: { type: String, enum: ['receipt', 'manual'], required: true },
  // Groups every line that came from the same uploaded receipt.
  receipt_id: { type: String, index: true },
  // The purchase Entry written alongside this lot, so reports stay in sync.
  entry_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Entry' },
  created_at: { type: Date, default: Date.now }
});

stockSchema.index({ business_id: 1, created_at: -1 });
stockSchema.index({ business_id: 1, item: 1 });

const Stock = mongoose.model('Stock', stockSchema);
export default Stock;
