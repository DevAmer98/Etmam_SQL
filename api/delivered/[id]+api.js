import express from 'express';
import pkg from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // adjust path if needed
// import admin from '../../firebase-init.js';

const { Pool } = pkg;
const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err);
});

const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Operation timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// --- FCM Notification Utility ---
const sendFCMToRole = async (role, table, message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const query = `SELECT fcm_token FROM ${table} WHERE role = $1 AND active = TRUE`;
    const result = await executeWithRetry(() =>
      withTimeout(client.query(query, [role]), 10000)
    );

    const tokens = result.rows.map(row => row.fcm_token).filter(Boolean);
    if (tokens.length === 0) {
      console.warn(`No FCM tokens found for ${role}`);
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log(`Sent ${role} notifications:`, response);
    return response;
  } catch (error) {
    console.error(`Failed to send FCM to ${role}:`, error);
    throw error;
  } finally {
    client.release();
  }
};

const sendNotificationToSupervisor = (msg, title) =>
  sendFCMToRole('supervisor', 'Supervisors', msg, title);

const sendNotificationToStorekeeper = (msg, title) =>
  sendFCMToRole('storekeeper', 'Storekeepers', msg, title);

// --- Delivered Route ---

router.put(
  '/delivered/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400);
      throw new Error('Missing order ID');
    }

    const actualDeliveryDate = new Date().toISOString();
    const updateQuery = `
      UPDATE orders 
      SET status = 'Delivered',
          actual_delivery_date = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    await executeWithRetry(() =>
      withTimeout(pool.query(updateQuery, [id, actualDeliveryDate]), 10000)
    );

    await Promise.all([
      sendNotificationToSupervisor(`تم توصيل الطلب ${id}`),
      sendNotificationToStorekeeper(`تم توصيل الطلب ${id}`),
    ]);

    res.status(200).json({ message: 'Order delivered successfully' });
  })
);

export default router;
