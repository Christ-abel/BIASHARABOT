import mongoose from 'mongoose';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../report.js';

const businessSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  tillNumber: { type: String, default: () => process.env.PAYHERO_CHANNEL_ID || '6669' },
  // Language for the weekly report (dashboard and SMS). Owners registered
  // before this field existed have no value stored; Mongoose applies the
  // default on read, so they get English with no migration.
  reportLanguage: { type: String, enum: Object.keys(SUPPORTED_LANGUAGES), default: DEFAULT_LANGUAGE },
  created_at: { type: Date, default: Date.now }
});

export default mongoose.model('Business', businessSchema);
