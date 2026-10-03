import mongoose from 'mongoose';

const businessSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  tillNumber: { type: String, default: () => process.env.PAYHERO_CHANNEL_ID || '6669' },
  created_at: { type: Date, default: Date.now }
});

export default mongoose.model('Business', businessSchema);
