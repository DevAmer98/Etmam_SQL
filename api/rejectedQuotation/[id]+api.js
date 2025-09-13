import express from 'express';
import pkg from 'pg';
import admin from '../../firebase-init.js'; // make sure this is correct
import { asyncHandler } from '../../utils/asyncHandler.js';

const { Pool } = pkg;
const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry + timeout helpers
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise((res) => setTimeout(res, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database query timed out')), timeout)
    ),
  ]);

// Notification utility
const sendRoleNotification = async (role, table, message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const query = `SELECT fcm_token FROM ${table} WHERE role = $1 AND active = TRUE`;
    const result = await executeWithRetry(() =>
      withTimeout(client.query(query, [role]), 10000)
    );

    const tokens = result.rows.map(row => row.fcm_token).filter(Boolean);

    if (tokens.length === 0) {
      console.warn(`No FCM tokens found for ${role}s.`);
      return;
    }

    const messages = tokens.map(token => ({
      notification: { title, body: message },
      data: { role },
      token,
    }));

    const response = await admin.messaging().sendEach(messages);
    console.log(`✅ ${role} notifications sent:`, response.successCount);
    return response;
  } catch (err) {
    console.error(`❌ Failed to send ${role} notifications:`, err.message);
    throw err;
  } finally {
    client.release();
  }
};

// PUT /not-delivered/:id
router.put(
  '/rejectedQuotation/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Missing quotation ID' });
    }

    const client = await pool.connect();
    try {
      const updateQuery = `
        UPDATE quotations 
        SET status = 'rejected',
            notes = $1,
            updated_at = CURRENT_TIMESTAMP,
            supervisoraccept = 'pending',
            manageraccept = 'pending',
            storekeeperaccept = 'pending'
        WHERE id = $2
        RETURNING *
      `;

      const result = await executeWithRetry(() =>
        withTimeout(client.query(updateQuery, [notes || '', id]), 10000)
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Quotation not found' });
      }

      const alertMessage = ` تم رفض العرض ${id}`;
      await Promise.all([
        sendRoleNotification('supervisor', 'Supervisors', alertMessage),
        sendRoleNotification('salesRep', 'SalesReps', alertMessage),
      ]);

      return res.status(200).json({ message: 'Quotation marked as rejected' });
    } catch (err) {
      console.error('❌ Quotation update error:', err);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
      });
    } finally {
      client.release();
    }
  })
);

export default router;
