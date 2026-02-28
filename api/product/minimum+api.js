import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

const ensureTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS product_minimums (
      code TEXT PRIMARY KEY,
      minimum_qty NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

// GET /api/products/minimums?codes=CODE1,CODE2
router.get('/products/minimums', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);

    const codesRaw = (req.query.codes || '').toString().trim();
    if (!codesRaw) {
      const result = await client.query(
        `SELECT code, minimum_qty, updated_at FROM product_minimums ORDER BY code`
      );
      return res.status(200).json({ items: result.rows });
    }

    const codes = codesRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (!codes.length) return res.status(200).json({ items: [] });

    const result = await client.query(
      `SELECT code, minimum_qty, updated_at
       FROM product_minimums
       WHERE code = ANY($1::text[])
       ORDER BY code`,
      [codes]
    );
    return res.status(200).json({ items: result.rows });
  } finally {
    client.release();
  }
}));

// PUT /api/products/minimums/:code { minimum_qty }
router.put('/products/minimums/:code', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);

    const code = (req.params.code || '').toString().trim();
    const minRaw = req.body?.minimum_qty;
    const minimumQty = Number(minRaw);

    if (!code) return res.status(400).json({ error: 'Product code is required' });
    if (Number.isNaN(minimumQty) || minimumQty < 0) {
      return res.status(400).json({ error: 'minimum_qty must be a non-negative number' });
    }

    const result = await client.query(
      `INSERT INTO product_minimums (code, minimum_qty, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (code)
       DO UPDATE SET minimum_qty = EXCLUDED.minimum_qty, updated_at = CURRENT_TIMESTAMP
       RETURNING code, minimum_qty, updated_at`,
      [code, minimumQty]
    );

    return res.status(200).json({ item: result.rows[0] });
  } finally {
    client.release();
  }
}));

export default router;

