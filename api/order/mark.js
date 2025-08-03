import express from 'express';
import admin from '../../firebase-init.js';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Utility: Retry DB operations
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

// Utility: Add timeout to DB queries
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Test DB connection
async function testConnection() {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ Database connection successful:', res.rows);
  } catch (error) {
    console.error('❌ Database connection error:', error);
  }
}
testConnection();

// 🚀 PUT /mark/:id
router.put('/mark/:id', async (req, res) => {
  console.log('📥 PUT /mark/:id called');
  console.log('🧾 Params:', req.params);
  console.log('🧾 Body:', req.body);

  const { id } = req.params;
  const { mark } = req.body;

  if (!id) {
    console.warn('⚠️ Missing order ID in request');
    return res.status(400).json({ error: 'Missing order ID' });
  }

  if (!['done', 'pending'].includes(mark)) {
    console.warn('⚠️ Invalid mark value received:', mark);
    return res.status(400).json({ error: 'Invalid mark value', received: mark });
  }

  try {
    const updateOrderQuery = `
      UPDATE orders 
      SET mark = $1,
          markAsDone_at = CASE WHEN $1 = 'done' THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `;

    console.log('📝 Executing query with values:', [mark, id]);
    const result = await executeWithRetry(() =>
      withTimeout(pool.query(updateOrderQuery, [mark, id]), 10000)
    );

    console.log('✅ Update successful. Rows affected:', result.rowCount);

    if (result.rowCount === 0) {
      console.warn('⚠️ Order not found for ID:', id);
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.status(200).json({ message: `Order marked as ${mark} successfully` });
  } catch (error) {
    console.error('🔥 Database error during update:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  }
});

export default router;
