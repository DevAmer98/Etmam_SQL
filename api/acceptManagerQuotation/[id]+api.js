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

// Retry and timeout helpers
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

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Optional: Test DB connection once
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ DB connected:', res.rows);
  } catch (error) {
    console.error('❌ DB connection failed:', error);
  }
})();

// Send notifications to supervisors
const sendNotificationToSupervisors = async (message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(
        client.query('SELECT fcm_token FROM Supervisors WHERE role = $1 AND active = TRUE', ['supervisor']),
        10000
      )
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);

    if (tokens.length === 0) {
      console.warn('⚠️ No FCM tokens found for supervisors');
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role: 'supervisor' },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log('✅ Notifications sent:', response);
    return response;
  } catch (error) {
    console.error('🚨 Failed to send FCM notifications:', error);
    // Safe to ignore Firebase errors for UX
  } finally {
    client.release();
  }
};

// PUT /acceptManagerQuotation/:id
router.put('/acceptManagerQuotation/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Missing quotation ID' });
  }

  const client = await pool.connect();
  try {
    const updateQuery = `
      UPDATE quotations
      SET manageraccept = 'accepted',
          manageraccept_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [id]), 10000)
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    await sendNotificationToSupervisors(`تم قبول عرض السعر ${id} من قبل المدير.`);

    return res.status(200).json({ message: 'Quotation accepted successfully' });
  } catch (error) {
    console.error('❌ Quotation update error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
