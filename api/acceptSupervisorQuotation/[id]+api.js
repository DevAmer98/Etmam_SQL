import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // Adjust if needed
import admin from '../../firebase-init.js'; 

const router = express.Router();

/*
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // 👈 Disables SSL
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry wrapper
const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
};

// Timeout wrapper
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Generic FCM notification
const sendNotificationToRole = async (table, role, message, title = 'Notification') => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(client.query(`SELECT fcm_token FROM ${table} WHERE role = $1 AND active = TRUE`, [role]), 10000)
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);
    if (tokens.length === 0) {
      console.warn(`No FCM tokens for ${role}s.`);
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
    console.error(`❌ Error sending notification to ${role}s:`, err);
  } finally {
    client.release();
  }
};

// PUT /acceptSupervisorQuotation/:id
router.put('/acceptSupervisorQuotation/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing quotation ID' });
  }

  const client = await pool.connect();
  try {
    const updateQuery = `
      UPDATE quotations 
      SET supervisoraccept = 'accepted',
          supervisoraccept_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING custom_id 

    `;

    const result = await executeWithRetry(() =>
      withTimeout(client.query(updateQuery, [id]), 10000)
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

              const customId = result.rows[0]?.custom_id; 

    await sendNotificationToRole('Managers', 'manager', `تم قبول عرض السعر رقم ${customId} من قبل المشرف.`, 'المشرف قبل عرض السعر');
    await sendNotificationToRole('Salesreps', 'salesRep', `تم قبول عرض السعر رقم ${customId} من قبل المشرف.`, 'المشرف قبل عرض السعر');

    return res.status(200).json({ message: 'Quotation accepted successfully' });
  } catch (err) {
    console.error('Database error:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: err.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
