import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // Adjust path if needed
//import admin from '../../firebase-init.js'; 

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry wrapper
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

// Timeout wrapper
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Optional DB connectivity test
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ DB connection successful:', res.rows);
  } catch (error) {
    console.error('❌ DB connection error:', error);
  }
})();

const sendNotificationToSupervisors = async (message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(
        client.query(
          'SELECT fcm_token FROM Supervisors WHERE role = $1 AND active = TRUE',
          ['supervisor']
        ),
        10000
      )
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);

    if (tokens.length === 0) {
      console.warn('⚠️ No FCM tokens found for supervisors.');
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role: 'supervisor' },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log('✅ Notifications sent to supervisors:', response);
    return response;
  } catch (error) {
    console.error('🚨 Failed to send FCM messages:', error);
    // Don't throw: failure to notify shouldn't break order update
  } finally {
    client.release();
  }
};

router.put('/acceptManager/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  const client = await pool.connect();
  try {
    const updateQuery = `
      UPDATE orders 
      SET manageraccept = 'accepted',
          manageraccept_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [id]), 10000)
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await sendNotificationToSupervisors(`تم قبول الطلب ${id} من قبل المدير.`);

    return res.status(200).json({ message: 'Order accepted successfully' });
  } catch (error) {
    console.error('❌ Order accept error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
