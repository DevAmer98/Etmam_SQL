import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // adjust path if needed

const router = express.Router();

// PostgreSQL pool setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry utility
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

// Timeout utility
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// 🔍 Test connection once on server startup
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ DB connection test passed:', res.rows);
  } catch (error) {
    console.error('❌ DB connection test failed:', error);
  }
})();

// ---------------------------------------------
// GET /api/clients/:id
router.get('/clients/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing client ID' });

  const clientQuery = 'SELECT * FROM clients WHERE id = $1';
  const result = await executeWithRetry(() =>
    withTimeout(pool.query(clientQuery, [id]), 10000)
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Client not found', id });
  }

  return res.status(200).json(result.rows[0]);
}));

// ---------------------------------------------
// PUT /api/clients/:id
router.put('/clients/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    company_name, client_name, phone_number, tax_number,
    branch_number, latitude, longitude, street, city, region,
  } = req.body;

  if (!id) return res.status(400).json({ error: 'Missing client ID' });

  const updateQuery = `
    UPDATE clients 
    SET 
      company_name = $1,
      client_name = $2,
      phone_number = $3,
      tax_number = $4,
      branch_number = $5,
      latitude = $6,
      longitude = $7,
      street = $8,
      city = $9,
      region = $10,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $11
  `;

  const values = [
    company_name, client_name, phone_number, tax_number,
    branch_number, latitude, longitude, street, city, region, id
  ];

  const result = await executeWithRetry(() =>
    withTimeout(pool.query(updateQuery, values), 10000)
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Client not found or no changes made' });
  }

  return res.status(200).json({ message: 'Client updated successfully' });
}));

// ---------------------------------------------
// DELETE /api/clients/:id
router.delete('/clients/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing client ID' });

  const deleteQuery = 'DELETE FROM clients WHERE id = $1';
  const result = await executeWithRetry(() =>
    withTimeout(pool.query(deleteQuery, [id]), 10000)
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Client not found' });
  }

  return res.status(200).json({ message: 'Client deleted successfully' });
}));

export default router;
