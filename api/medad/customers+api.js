import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

// GET /api/medad/customers?search=&page=&limit=
router.get('/medad/customers', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const search = `%${req.query.search || ''}%`;
    const offset = (page - 1) * limit;

    const baseWhere = `
      WHERE customer_name ILIKE $1
      OR vat_no ILIKE $1
      OR phone ILIKE $1
    `;

    const customersQuery = `
      SELECT *
      FROM medad_customers_import
      ${baseWhere}
      ORDER BY customer_name
      LIMIT $2 OFFSET $3
    `;

    const customersResult = await executeWithRetry(() =>
      withTimeout(client.query(customersQuery, [search, limit, offset]), 10000)
    );

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM medad_customers_import
      ${baseWhere}
    `;

    const countResult = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, [search]), 10000)
    );

    const total = parseInt(countResult.rows[0]?.count || '0', 10);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      customers: customersResult.rows,
      total,
      page,
      totalPages,
      limit,
    });
  } finally {
    client.release();
  }
}));

// GET /api/medad/linked?search=&page=&limit=
router.get('/medad/linked', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const search = `%${req.query.search || ''}%`;
    const offset = (page - 1) * limit;

    const hasSearch = !!req.query.search;
    const whereClause = hasSearch
      ? 'WHERE CAST(client_id AS TEXT) ILIKE $1 OR CAST(medad_customer_id AS TEXT) ILIKE $1'
      : '';

    const linkedQuery = `
      SELECT *
      FROM client_medad_customers
      ${whereClause}
      ORDER BY id DESC
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
    `;

    const linkedResult = await executeWithRetry(() =>
      withTimeout(
        client.query(linkedQuery, hasSearch ? [search, limit, offset] : [limit, offset]),
        10000
      )
    );

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM client_medad_customers
      ${whereClause}
    `;

    const countResult = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, hasSearch ? [search] : []), 10000)
    );

    const total = parseInt(countResult.rows[0]?.count || '0', 10);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      linked: linkedResult.rows,
      total,
      page,
      totalPages,
      limit,
    });
  } finally {
    client.release();
  }
}));

export default router;
