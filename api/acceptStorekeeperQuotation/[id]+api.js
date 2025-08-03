import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // Adjust path as needed
//import admin from '../../firebase-init.js'; 

const router = express.Router();

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Utility: Retry with backoff
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

// Utility: Query timeout
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Test DB connection on boot
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ DB connected:', res.rows);
  } catch (err) {
    console.error('❌ DB connection failed:', err);
  }
})();

// Firebase notification sender
const sendNotificationToDriver = async (message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(
        client.query(`SELECT fcm_token FROM Drivers WHERE role = $1 AND active = TRUE`, ['driver']),
        10000
      )
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);
    if (tokens.length === 0) {
      console.warn('⚠️ No FCM tokens found for drivers.');
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role: 'driver' },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log('✅ FCM messages sent:', response);
    return response;
  } catch (error) {
    console.error('❌ Failed to send FCM messages:', error);
    // Don't throw — allow main logic to proceed
  } finally {
    client.release();
  }
};

// PUT /acceptStorekeeperQuotation/:id
router.put('/acceptStorekeeperQuotation/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Missing quotation ID' });
  }

  const client = await pool.connect();
  try {
    const updateQuery = `
      UPDATE quotations 
      SET storekeeperaccept = 'accepted',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [id]), 10000)
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Quotation not found or not updated' });
    }

    await sendNotificationToDriver(
      `تم قبول عرض السعر ${id} من قبل أمين المخزن.`,
      'الطلب جاهز للتوصيل'
    );

    return res.status(200).json({ message: 'Quotation accepted successfully' });
  } catch (error) {
    console.error('❌ Quotation update failed:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
