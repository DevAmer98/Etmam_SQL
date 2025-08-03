import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // Adjust path as needed
import admin from '../../firebase-init.js';

const router = express.Router();

// DB Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry + Timeout Helpers
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      await new Promise(res => setTimeout(res, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// FCM: Notify users
const sendNotificationToRole = async (table, role, message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const query = `SELECT fcm_token FROM ${table} WHERE role = $1 AND active = TRUE`;
    const result = await executeWithRetry(() =>
      withTimeout(client.query(query, [role]), 10000)
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);
    if (tokens.length === 0) {
      console.warn(`⚠️ No FCM tokens found for ${role}s.`);
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log(`✅ Notifications sent to ${role}s:`, response);
    return response;
  } catch (err) {
    console.error(`❌ FCM error for ${role}s:`, err);
    // Don't crash — fail silently here
  } finally {
    client.release();
  }
};

// PUT /acceptSupervisor/:id
router.put('/acceptSupervisor/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  const client = await pool.connect();
  try {
    const updateQuery = `
      UPDATE orders 
      SET supervisoraccept = 'accepted',
          supervisoraccept_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [id]), 10000)
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await sendNotificationToRole(
      'Storekeepers',
      'storekeeper',
      `تم قبول الطلب رقم ${id} من قبل المشرف.`,
      'المشرف قبل الطلب'
    );

    await sendNotificationToRole(
      'Managers',
      'manager',
      `تم قبول الطلب رقم ${id} من قبل المشرف.`,
      'المشرف قبل الطلب'
    );

    return res.status(200).json({ message: 'Order accepted successfully' });
  } catch (err) {
    console.error('❌ Error updating order:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: err.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
