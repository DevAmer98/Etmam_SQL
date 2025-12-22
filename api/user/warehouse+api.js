import express from 'express';
import pg from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const { Pool } = pg;
const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_warehouses (
      clerk_id TEXT PRIMARY KEY,
      warehouse_code TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
};

// GET /user/warehouse/:clerkId
router.get(
  '/user/warehouse/:clerkId',
  asyncHandler(async (req, res) => {
    const { clerkId } = req.params;
    if (!clerkId) return res.status(400).json({ success: false, message: 'Missing clerkId' });
    await ensureTable();
    const result = await pool.query('SELECT warehouse_code FROM user_warehouses WHERE clerk_id = $1', [clerkId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.status(200).json({ success: true, warehouse_code: result.rows[0].warehouse_code });
  })
);

// PUT /user/warehouse
router.put(
  '/user/warehouse',
  asyncHandler(async (req, res) => {
    const { clerkId, warehouseCode } = req.body || {};
    if (!clerkId || !warehouseCode) {
      return res.status(400).json({ success: false, message: 'clerkId and warehouseCode are required' });
    }
    await ensureTable();
    const result = await pool.query(
      `
        INSERT INTO user_warehouses (clerk_id, warehouse_code)
        VALUES ($1, $2)
        ON CONFLICT (clerk_id)
        DO UPDATE SET warehouse_code = EXCLUDED.warehouse_code, updated_at = NOW()
        RETURNING clerk_id, warehouse_code, updated_at;
      `,
      [clerkId, warehouseCode]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  })
);

export default router;
