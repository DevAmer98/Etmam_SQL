//api/material/request+api.js
import express from 'express';
import { Pool } from 'pg';
import admin from '../../firebase-init.js';

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

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

const ensureTable = async client => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS material_requests (
      id SERIAL PRIMARY KEY,
      products JSONB NOT NULL,
      request_all BOOLEAN DEFAULT FALSE,
      requested_by TEXT,
      note TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await executeWithRetry(() => withTimeout(client.query(createSql), 10000));
};

const sendNotificationToManagers = async (summary, count) => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(
        client.query('SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE', ['manager']),
        10000
      )
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);
    if (!tokens.length) {
      console.warn('⚠️ No FCM tokens found for managers. Skipping notification.');
      return;
    }

    const body = `${summary}${count ? ` (${count})` : ''} بانتظار موافقتك.`;
    const messages = tokens.map(token => ({
      notification: {
        title: 'طلب مواد جديد',
        body,
      },
      data: {
        role: 'manager',
        type: 'material_request',
      },
      token,
    }));

    await admin.messaging().sendEach(messages);
  } catch (err) {
    console.error('🚨 Failed to send FCM messages to managers:', err);
  } finally {
    client.release();
  }
};

router.post('/requestMaterial', async (req, res) => {
  const { products = [], requestAll = false, requestedBy = null, note = null } = req.body || {};

  const normalizedProducts = Array.isArray(products)
    ? products.map(p => ({
        id: p.id ?? p.productNo ?? p.code ?? null,
        name: p.name ?? p.description ?? 'بدون اسم',
        code: p.code ?? p.productNo ?? '',
        quantity: Number(p.quantity ?? p.availableQuantity ?? p.qty ?? 0) || 0,
        section: p.section_name ?? p.category ?? '',
        supplier: p.supplier_name ?? p.vendorName ?? '',
        company: p.company_name ?? p.vendorId ?? '',
      }))
    : [];

  if (!requestAll && normalizedProducts.length === 0) {
    return res.status(400).json({ error: 'No products provided for material request' });
  }

  const client = await pool.connect();
  try {
    await ensureTable(client);

    const insertSql = `
      INSERT INTO material_requests (products, request_all, requested_by, note, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id, created_at
    `;
    const insertParams = [JSON.stringify(normalizedProducts), requestAll, requestedBy, note];
    const result = await executeWithRetry(() => withTimeout(client.query(insertSql, insertParams), 10000));
    const requestId = result.rows[0]?.id;

    const summary = requestAll ? 'طلب جميع المنتجات' : 'طلب مواد محددة';
    await sendNotificationToManagers(summary, normalizedProducts.length);

    return res.status(201).json({
      success: true,
      requestId,
      message: 'تم إرسال طلب المواد للمدير للموافقة',
    });
  } catch (err) {
    console.error('❌ Failed to create material request:', err);
    return res.status(500).json({ error: err.message || 'Failed to create material request' });
  } finally {
    client.release();
  }
});

// Fetch material requests
router.get('/requestMaterial', async (_req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const selectSql = `
      SELECT id, products, request_all, requested_by, note, status, created_at
      FROM material_requests
      ORDER BY created_at DESC
    `;
    const result = await executeWithRetry(() => withTimeout(client.query(selectSql), 10000));
    return res.status(200).json({
      success: true,
      requests: result.rows || [],
    });
  } catch (err) {
    console.error('❌ Failed to fetch material requests:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch material requests' });
  } finally {
    client.release();
  }
});

export default router;
