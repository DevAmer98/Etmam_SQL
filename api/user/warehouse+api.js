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
      warehouse_codes TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE user_warehouses
      ADD COLUMN IF NOT EXISTS warehouse_codes TEXT[];
    ALTER TABLE user_warehouses
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  `);
};

// GET /user/warehouse/:clerkId
router.get(
  '/user/warehouse/:clerkId',
  asyncHandler(async (req, res) => {
    const { clerkId } = req.params;
    if (!clerkId) return res.status(400).json({ success: false, message: 'Missing clerkId' });
    await ensureTable();
    const result = await pool.query('SELECT warehouse_code, warehouse_codes FROM user_warehouses WHERE clerk_id = $1', [clerkId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const row = result.rows[0];
    res.status(200).json({ success: true, warehouse_code: row.warehouse_code, warehouse_codes: row.warehouse_codes || [] });
  })
);

// PUT /user/warehouse
router.put(
  '/user/warehouse',
  asyncHandler(async (req, res) => {
    const { clerkId, warehouseCode, warehouseCodes } = req.body || {};
    const codesArray = Array.isArray(warehouseCodes)
      ? warehouseCodes.filter((c) => !!c).map(String)
      : [];
    const primaryCode = warehouseCode || codesArray[0];

    if (!clerkId || !primaryCode) {
      return res.status(400).json({ success: false, message: 'clerkId and at least one warehouse code are required' });
    }
    await ensureTable();
    const result = await pool.query(
      `
        INSERT INTO user_warehouses (clerk_id, warehouse_code)
        VALUES ($1, $2)
        ON CONFLICT (clerk_id)
        DO UPDATE SET warehouse_code = EXCLUDED.warehouse_code, updated_at = NOW()
        RETURNING clerk_id, warehouse_code, warehouse_codes, created_at, updated_at;
      `,
      [clerkId, primaryCode]
    );
    // If array provided, update it in a second pass to keep compatibility with older rows
    if (codesArray.length) {
      const updateArr = await pool.query(
        `
          UPDATE user_warehouses
          SET warehouse_codes = $1, updated_at = NOW()
          WHERE clerk_id = $2
          RETURNING clerk_id, warehouse_code, warehouse_codes, created_at, updated_at;
        `,
        [codesArray, clerkId]
      );
      return res.status(200).json({ success: true, data: updateArr.rows[0] });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  })
);

export default router;
