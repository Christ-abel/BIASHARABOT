import express from 'express';
import cors from 'cors';
import multer from 'multer';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import Entry from './models/Entry.js';
import Business from './models/Business.js';
import Stock from './models/Stock.js';
import { parseTextWithGemini, parseAudioWithGemini, parseReceiptWithGemini, translatePhrasesWithGemini } from './gemini.js';
import { sanitizeReceiptParse, validateStockItem, validateStockBatch } from './stock-validation.js';
import { persistStockLots } from './stock.js';
import { buildWeeklyReport } from './profit.js';
import { assembleLocalizedReport, normalizeReportLanguage } from './report.js';
import { REPORT_LANGUAGES, isSupportedReportLanguage } from './languages.js';
import { COMPLIANCE_LABELS } from './report-labels.js';
import { toPublicBusiness } from './business-public.js';
import { KENYA_COUNTIES } from './compliance-config.js';
import { evaluateCompliance } from './compliance-rules.js';
import { dispatchComplianceNotices, phraseCompliance } from './compliance-notices.js';
import ComplianceNotice from './models/ComplianceNotice.js';
import { triggerSTKPush } from './payments.js';
import { sendSMS } from './sms.js';
import {
  findByClientId,
  reconcileOfflineSale,
  resolveTimestamp,
  saveEntryIdempotently
} from './offline-sync.js';
import bcrypt from 'bcryptjs';
import { complianceRouter, startComplianceWorker } from './compliance-api.js';
import { validateProfile } from './compliance.js';

// Resolve configuration relative to this file, independent of the launch directory.
// Hosted environment variables win over backend/.env.
dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api', (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database unavailable. Please try again shortly.' });
  }
  next();
});
app.use('/api/compliance', complianceRouter);

// Memory storage for audio and receipt uploads (prevents disk clutter)
const upload = multer({ storage: multer.memoryStorage() });

const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_TYPES = /^(image\/(jpeg|jpg|png|webp|heic|heif)|application\/pdf)$/i;

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (RECEIPT_TYPES.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Receipt must be a photo (JPG, PNG, WebP) or a PDF scan'));
  }
});

/** Turn multer's file-filter / size errors into a 400 the dashboard can show. */
function acceptReceiptFile(req, res, next) {
  receiptUpload.single('receipt')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Receipt file is too large (max 8 MB)' });
    }
    return res.status(400).json({ error: err.message || 'Could not read the uploaded file' });
  });
}

// MongoDB Connection
const mongoURI = process.env.MONGODB_URI?.trim();
if (!mongoURI) {
  console.error('MONGODB_URI is missing. Configure backend/.env or a hosted environment variable.');
  process.exit(1);
}
mongoose.set('bufferCommands', false);

// 1. Text Entry Endpoint
app.post('/api/entries/text', async (req, res) => {
  try {
    const { text, businessId, clientId, occurredAt } = req.body;
    if (!text) {
      return res.status(400).json({ error: "Text entry is required" });
    }

    const alreadyStored = await findByClientId(clientId);
    if (alreadyStored) {
      console.log(`[IDEMPOTENT] clientId ${clientId} already logged; returning stored entry`);
      return res.status(200).json(alreadyStored);
    }

    const parsed = await parseTextWithGemini(text);
    console.log("[TEXT PARSED SUCCESS]", parsed);

    // Guard: reject entries Gemini couldn't assign a valid amount to,
    // so bad data never reaches the DB and poisons report totals.
    if (parsed.total === undefined || parsed.total === null || isNaN(Number(parsed.total))) {
      console.warn("[BAD PARSE] Gemini returned no valid total (text):", parsed);
      return res.status(422).json({ error: "Could not determine an amount for that entry", parsed });
    }

    const entry = new Entry({
      business_id: businessId || 'demo-shop',
      type: parsed.type,
      item: parsed.item,
      qty: parsed.qty,
      unit_price: parsed.unit_price,
      total: parsed.total,
      transcription: parsed.transcription || text,
      source: 'text',
      matched: false,
      client_id: clientId || undefined,
      timestamp: resolveTimestamp(occurredAt)
    });

    const { entry: saved, duplicate } = await saveEntryIdempotently(entry, clientId);
    if (!duplicate && clientId) await reconcileOfflineSale(saved);
    res.status(duplicate ? 200 : 201).json(saved);
  } catch (error) {
    console.error("Text entry endpoint error:", error);
    res.status(500).json({ error: "Failed to process text entry", details: error.message });
  }
});

// 2. Voice Entry Endpoint
app.post('/api/entries/voice', upload.single('audio'), async (req, res) => {
  try {
    const { businessId, clientId, occurredAt } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    // A queued voice note may be re-uploaded; never transcribe or bill twice.
    const alreadyStored = await findByClientId(clientId);
    if (alreadyStored) {
      console.log(`[IDEMPOTENT] clientId ${clientId} already logged; returning stored entry`);
      return res.status(200).json(alreadyStored);
    }

    const mimeType = req.file.mimetype || 'audio/webm';
    console.log(`[VOICE UPLOADED] File size: ${req.file.size} bytes, Mime: ${mimeType}`);

    const parsed = await parseAudioWithGemini(req.file.buffer, mimeType);
    console.log("[AUDIO PARSED SUCCESS]", parsed);

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    // Guard: reject entries Gemini couldn't assign a valid amount to,
    // so bad data never reaches the DB and poisons report totals.
    if (parsed.total === undefined || parsed.total === null || isNaN(Number(parsed.total))) {
      console.warn("[BAD PARSE] Gemini returned no valid total (voice):", parsed);
      return res.status(422).json({ error: "Could not determine an amount for that entry", parsed });
    }

    const entry = new Entry({
      business_id: businessId || 'demo-shop',
      type: parsed.type,
      item: parsed.item,
      qty: parsed.qty,
      unit_price: parsed.unit_price,
      total: parsed.total,
      transcription: parsed.transcription || 'Spoken transaction',
      source: 'voice',
      matched: false,
      client_id: clientId || undefined,
      timestamp: resolveTimestamp(occurredAt)
    });

    const { entry: saved, duplicate } = await saveEntryIdempotently(entry, clientId);
    if (!duplicate && clientId) await reconcileOfflineSale(saved);
    res.status(duplicate ? 200 : 201).json(saved);
  } catch (error) {
    console.error("Voice entry endpoint error:", error);
    res.status(500).json({ error: "Failed to process voice entry", details: error.message });
  }
});

// 3. Retrieve Entries Endpoint
app.get('/api/entries', async (req, res) => {
  try {
    const { businessId } = req.query;
    const bid = businessId || 'demo-shop';
    const entries = await Entry.find({ business_id: bid }).sort({ timestamp: -1 });
    res.json(entries);
  } catch (error) {
    console.error("Get entries error:", error);
    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

// 4. Trigger STK Push Endpoint
app.post('/api/payments/stk-push', async (req, res) => {
  try {
    const { entryId, phone } = req.body;
    if (!entryId || !phone) {
      return res.status(400).json({ error: "Entry ID and Phone number are required" });
    }

    const entry = await Entry.findById(entryId);
    if (!entry) {
      return res.status(404).json({ error: "Ledger entry not found" });
    }

    const biz = await Business.findOne({ id: entry.business_id });
    const channelId = biz ? biz.tillNumber : null;

    const host = req.get('host');
    const protocol = req.secure ? 'https' : 'http';
    const callbackUrl = `${protocol}://${host}/api/webhooks/payhero`;

    const result = await triggerSTKPush({
      amount: entry.total,
      phone,
      entryId: entry._id.toString(),
      callbackUrl,
      channelId
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error("STK push endpoint error:", error);
    res.status(500).json({ error: "Failed to trigger payment" });
  }
});

// 5. PayHero M-Pesa Webhook Endpoint (Reconciliation)
app.post('/api/webhooks/payhero', async (req, res) => {
  try {
    console.log("[PAYHERO WEBHOOK RECEIVED] Payload:", req.body);

    const payload = req.body;
    const status = payload.status || (payload.ResultCode === 0 ? 'success' : 'failed');
    const amount = parseFloat(payload.amount || payload.Amount || 0);
    const externalRef = payload.external_reference || payload.merchant_transaction_id || payload.CheckoutRequestID;
    const serviceCharge = parseFloat(payload.service_charge || payload.ServiceCharge || 0);
    const phone = payload.phone || payload.phone_number || (payload.MpesaReceiptNumber ? 'M-Pesa Customer' : '');

    if (status !== 'success' && status !== 'SUCCESS') {
      console.log(`[PAYHERO WEBHOOK] Transaction failed or status is not success: ${status}`);
      return res.json({ status: "acknowledged", message: "Non-success status ignored" });
    }

    let matchedEntry = null;

    if (externalRef && mongoose.Types.ObjectId.isValid(externalRef)) {
      matchedEntry = await Entry.findById(externalRef);
      if (matchedEntry) {
        console.log(`[RECONCILIATION] Matched by ID: ${externalRef}`);
        matchedEntry.matched = true;
        await matchedEntry.save();
      }
    }

    if (!matchedEntry && amount > 0) {
      matchedEntry = await Entry.findOne({
        type: 'sale',
        total: amount,
        matched: false,
        source: { $in: ['voice', 'text'] }
      }).sort({ timestamp: 1 });

      if (matchedEntry) {
        console.log(`[RECONCILIATION] Matched by amount (KSh ${amount}) to Entry: ${matchedEntry._id}`);
        matchedEntry.matched = true;
        await matchedEntry.save();
      } else {
        console.log(`[RECONCILIATION] Unmatched payment of KSh ${amount}. Creating new entry.`);
        matchedEntry = new Entry({
          business_id: 'demo-shop',
          type: 'sale',
          item: `M-Pesa Payment (${phone || 'Unrecognized'})`,
          qty: 1,
          unit_price: amount,
          total: amount,
          source: 'payhero',
          matched: false
        });
        await matchedEntry.save();
      }
    }

    if (serviceCharge > 0) {
      console.log(`[RECONCILIATION] Recording M-Pesa service charge: KSh ${serviceCharge}`);
      const feeEntry = new Entry({
        business_id: matchedEntry ? matchedEntry.business_id : 'demo-shop',
        type: 'expense',
        item: `M-Pesa Fee (PH_${externalRef || 'webhook'})`,
        qty: 1,
        unit_price: serviceCharge,
        total: serviceCharge,
        source: 'payhero',
        matched: true
      });
      await feeEntry.save();
    }

    res.json({ status: "success", message: "Transaction reconciled successfully" });
  } catch (error) {
    console.error("Webhook endpoint error:", error);
    res.status(500).json({ error: "Webhook processing failed", details: error.message });
  }
});

// 5b. Tiara Connect DELIVERY_REPORT Webhook
// Register in Tiara dashboard as callback type: DELIVERY_REPORT
// URL: https://biasharagpt.onrender.com/api/webhooks/tiara-delivery
app.post('/api/webhooks/tiara-delivery', (req, res) => {
  console.log("[TIARA DELIVERY_REPORT]", JSON.stringify(req.body, null, 2));
  // Once you see the real payload shape here, match req.body.refId
  // against the refId returned by sendSMS() to track per-message status.
  res.status(200).json({ received: true });
});

// 5c. Tiara Connect MO (Mobile Originated) Webhook
// Register in Tiara dashboard as callback type: MO
// URL: https://biasharagpt.onrender.com/api/webhooks/tiara-mo
app.post('/api/webhooks/tiara-mo', (req, res) => {
  console.log("[TIARA MO]", JSON.stringify(req.body, null, 2));
  // TODO: extract sender phone + message text, route through
  // parseTextWithGemini() to log as a ledger entry from SMS.
  res.status(200).json({ received: true });
});

// 6. Weekly Report Endpoint & SMS Trigger
app.get('/api/reports/weekly', async (req, res) => {
  try {
    const { businessId, phone, businessName } = req.query;
    const bid = businessId || 'demo-shop';
    const biz = await Business.findOne({ id: bid });
    const bname = biz?.name || businessName || 'My Duka';
    const language = normalizeReportLanguage(req.query.language || biz?.reportLanguage);

    console.log(`[WEEKLY REPORT] Generating report for Business: ${bname} (${bid}) lang=${language}`);

    const [entries, stockLots] = await Promise.all([
      Entry.find({ business_id: bid }),
      Stock.find({ business_id: bid })
    ]);

    // Cash-basis totals keep the same formula as before. Item-level gross
    // profit is computed from stock unit costs and sits beside them.
    const report = buildWeeklyReport(entries, stockLots);
    const localized = await assembleLocalizedReport({
      report,
      businessName: bname,
      language,
      translate: translatePhrasesWithGemini
    });

    let smsStatus = null;
    if (phone) {
      smsStatus = await sendSMS({ to: phone, message: localized.sms });
    }

    res.json({
      success: true,
      report: localized.report,
      labels: localized.labels,
      language: localized.language,
      languageFallback: localized.languageFallback,
      smsStatus
    });
  } catch (error) {
    console.error("Weekly report endpoint error:", error);
    res.status(500).json({ error: "Failed to generate weekly report", details: error.message });
  }
});

// 6b. Schedule a Mock Daily Report SMS for 60 seconds later
app.post('/api/reports/daily/schedule-test', async (req, res) => {
  try {
    const { phone = '0743177132', businessName = 'My Duka' } = req.body || {};

    const mockReport = {
      revenue: 12500,
      cost_of_goods: 7300,
      other_expenses: 1200,
      mpesa_fees: 50,
      net_profit: 3950,
      outstanding_credit: 800
    };

    const localized = await assembleLocalizedReport({
      report: {
        ...mockReport,
        gross_profit: 5200,
        gross_margin: 42,
        items_missing_cost: 0,
        item_profits: [
          { item: 'Loaves', gross_profit: 3200, margin: 48, cost_unknown: false },
          { item: 'Sugar', gross_profit: 2000, margin: 35, cost_unknown: false }
        ]
      },
      businessName,
      language: 'en',
      title: 'BiasharaGPT Daily Report'
    });
    const message = localized.sms;

    const jobId = `daily_report_${Date.now()}`;
    const delayMs = 60_000;

    setTimeout(async () => {
      try {
        console.log(`[SCHEDULED SMS] Sending job ${jobId} to ${phone}`);
        const result = await sendSMS({ to: phone, message });
        console.log(`[SCHEDULED SMS] Job ${jobId} completed:`, result);
      } catch (error) {
        console.error(`[SCHEDULED SMS] Job ${jobId} failed:`, error);
      }
    }, delayMs);

    res.json({
      success: true,
      scheduled: true,
      jobId,
      sendInSeconds: 60,
      phone,
      messagePreview: message
    });
  } catch (error) {
    console.error('Daily schedule test endpoint error:', error);
    res.status(500).json({ error: 'Failed to schedule daily report SMS', details: error.message });
  }
});

// 7. Verify Admin Password Endpoint
app.post('/api/admin/verify', async (req, res) => {
  try {
    const { password, businessId } = req.body;
    if (!businessId) {
      return res.status(400).json({ error: "Business ID is required for verification" });
    }

    const biz = await Business.findOne({ id: businessId });
    if (!biz) {
      return res.status(404).json({ error: "Business profile not found" });
    }

    const match = await bcrypt.compare(password, biz.password);
    if (match) {
      return res.json({ success: true });
    } else {
      return res.status(401).json({ error: "Invalid admin password" });
    }
  } catch (error) {
    console.error("Admin verification error:", error);
    res.status(500).json({ error: "Server error during verification" });
  }
});

// 8. Sign Up Business Endpoint
app.post('/api/business', async (req, res) => {
  try {
    const { name, phone, email, password, confirmPassword, tillNumber, reportLanguage } = req.body;
    if (!name || !phone || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    if (reportLanguage && !isSupportedReportLanguage(reportLanguage)) {
      return res.status(400).json({ error: 'Unsupported report language', allowed: REPORT_LANGUAGES });
    }

    let id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const existing = await Business.findOne({ id });
    if (existing) {
      id = `${id}-${Math.floor(1000 + Math.random() * 9000)}`;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const business = new Business({
      id,
      name,
      phone,
      email,
      password: hashedPassword,
      tillNumber: tillNumber || process.env.PAYHERO_CHANNEL_ID || '6669',
      reportLanguage: normalizeReportLanguage(reportLanguage)
    });

    await business.save();
    console.log(`[BUSINESS REGISTERED] ID: ${id}, Name: ${name}, Email: ${email}`);

    res.status(201).json(toPublicBusiness(business));
  } catch (error) {
    console.error("Business signup error:", error);
    res.status(500).json({ error: "Failed to register business profile" });
  }
});

// 9. Fetch Business Details Endpoint
app.get('/api/business/:id', async (req, res) => {
  try {
    const business = await Business.findOne({ id: req.params.id }).select('-password -complianceProfile');
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    res.json(toPublicBusiness(business));
  } catch (error) {
    console.error("Fetch business details error:", error);
    res.status(500).json({ error: "Failed to retrieve business profile" });
  }
});

// 9b. Update language and compliance profile. Old records without
// reportLanguage stay English via normalizeReportLanguage — no migration.
app.patch('/api/business/:id', async (req, res) => {
  try {
    const business = await Business.findOne({ id: req.params.id });
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const { reportLanguage, businessType, county, kraPin, estimatedAnnualTurnover } = req.body || {};

    if (reportLanguage !== undefined) {
      if (!isSupportedReportLanguage(reportLanguage)) {
        return res.status(400).json({ error: 'Unsupported report language', allowed: REPORT_LANGUAGES });
      }
      business.reportLanguage = reportLanguage;
    }

    if (businessType !== undefined) {
      if (!['sole_proprietor', 'partnership', 'company'].includes(businessType)) {
        return res.status(400).json({ error: 'Unsupported business type' });
      }
      business.businessType = businessType;
    }

    if (county !== undefined) {
      business.county = String(county).trim();
    }

    if (kraPin !== undefined) {
      if (!['unknown', 'yes', 'no'].includes(kraPin)) {
        return res.status(400).json({ error: 'kraPin must be unknown, yes or no' });
      }
      business.kraPin = kraPin;
    }

    if (estimatedAnnualTurnover !== undefined) {
      const amount = Number(estimatedAnnualTurnover);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'Estimated turnover must be a number of 0 or more' });
      }
      business.estimatedAnnualTurnover = amount;
    }

    await business.save();
    res.json(toPublicBusiness(business));
  } catch (error) {
    console.error('Business update error:', error);
    res.status(500).json({ error: 'Failed to update business profile', details: error.message });
  }
});

app.get('/api/languages', (_req, res) => {
  res.json({ languages: REPORT_LANGUAGES, default: 'en' });
});

// 9c. Personalised compliance checklist + optional one-shot SMS notices.
app.get('/api/compliance', async (req, res) => {
  try {
    const bid = req.query.businessId || 'demo-shop';
    const business = await Business.findOne({ id: bid });
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const language = normalizeReportLanguage(req.query.language || business.reportLanguage);
    const labels = COMPLIANCE_LABELS[language] || COMPLIANCE_LABELS.en;
    const entries = await Entry.find({ business_id: bid });
    const evaluation = evaluateCompliance({ profile: toPublicBusiness(business), entries });

    const obligations = evaluation.obligations.map((row) => ({
      id: row.id,
      applies: row.applies,
      status: row.status,
      deadline: row.deadline,
      title: phraseCompliance(labels, row.titleKey, row.vars),
      explanation: phraseCompliance(labels, row.bodyKey, row.vars)
    }));

    const triggers = evaluation.triggers.map((row) => ({
      id: row.id,
      message: phraseCompliance(labels, row.titleKey, row.vars)
    }));

    let notices = { sent: [], skipped: [] };
    if (req.query.notify === '1') {
      notices = await dispatchComplianceNotices({
        business: toPublicBusiness(business),
        evaluation,
        language
      });
    }

    const recent = await ComplianceNotice.find({ business_id: bid }).sort({ sent_at: -1 }).limit(20);

    res.json({
      language,
      labels,
      profileIncomplete: evaluation.profileIncomplete,
      turnover: evaluation.turnover,
      obligations,
      triggers,
      notices,
      sentHistory: recent,
      counties: KENYA_COUNTIES,
      profile: toPublicBusiness(business)
    });
  } catch (error) {
    console.error('Compliance endpoint error:', error);
    res.status(500).json({ error: 'Failed to load compliance information', details: error.message });
  }
});

// 10. Parse a receipt photo / PDF — extract only, never write.
// Phone photos are often blurry, so the owner reviews the lines before save.
app.post('/api/stock/receipt/parse', acceptReceiptFile, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'A receipt photo or PDF is required' });
    }

    const mimeType = req.file.mimetype || 'image/jpeg';
    console.log(`[RECEIPT UPLOADED] ${req.file.size} bytes, ${mimeType}`);

    const parsed = await parseReceiptWithGemini(req.file.buffer, mimeType);
    console.log('[RECEIPT PARSED]', parsed);

    const sanitized = sanitizeReceiptParse(parsed);
    if (!sanitized.ok) {
      return res.status(422).json({
        error: sanitized.error,
        rejected: sanitized.rejected || []
      });
    }

    res.json({
      supplier: sanitized.supplier,
      date: sanitized.date,
      line_items: sanitized.items,
      rejected: sanitized.rejected,
      mock: !process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'mock'
    });
  } catch (error) {
    console.error('Receipt parse endpoint error:', error);
    res.status(500).json({ error: 'Failed to read this receipt', details: error.message });
  }
});

// 11. Save reviewed receipt lines (or a typed batch) as stock + purchase entries.
app.post('/api/stock/confirm', async (req, res) => {
  try {
    const { businessId, items, supplier, date, source } = req.body || {};
    const origin = source === 'manual' ? 'manual' : 'receipt';

    const batch = validateStockBatch(items);
    if (!batch.ok) {
      return res.status(422).json({ error: batch.error });
    }

    const result = await persistStockLots({
      businessId,
      items: batch.items,
      source: origin,
      supplier: typeof supplier === 'string' ? supplier.trim() : '',
      purchaseDate: date || null
    });

    console.log(`[STOCK SAVED] ${result.count} lot(s) from ${origin} for ${businessId || 'demo-shop'}`);
    res.status(201).json(result);
  } catch (error) {
    console.error('Stock confirm endpoint error:', error);
    res.status(500).json({ error: 'Failed to save stock', details: error.message });
  }
});

// 12. Type one stock purchase in when there is no receipt.
app.post('/api/stock/manual', async (req, res) => {
  try {
    const { businessId, item, qty, unit_cost, total, supplier, date } = req.body || {};

    const checked = validateStockItem({ item, qty, unit_cost, total });
    if (!checked.ok) {
      return res.status(422).json({ error: checked.error });
    }

    const result = await persistStockLots({
      businessId,
      items: [checked.item],
      source: 'manual',
      supplier: typeof supplier === 'string' ? supplier.trim() : '',
      purchaseDate: date || null
    });

    console.log(`[STOCK MANUAL] ${checked.item.item} x${checked.item.qty} for ${businessId || 'demo-shop'}`);
    res.status(201).json({
      stock: result.lots[0],
      count: 1
    });
  } catch (error) {
    console.error('Manual stock endpoint error:', error);
    res.status(500).json({ error: 'Failed to save stock entry', details: error.message });
  }
});

// 13. Recent stock purchases for the dashboard list.
app.get('/api/stock', async (req, res) => {
  try {
    const bid = req.query.businessId || 'demo-shop';
    const lots = await Stock.find({ business_id: bid }).sort({ created_at: -1 }).limit(100);
    res.json(lots);
  } catch (error) {
    console.error('Get stock error:', error);
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`BiasharaGPT Server running on http://localhost:${PORT}`);
});
// Nodemon trigger change
