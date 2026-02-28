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
    const offset = (page - 1) * limit;

    const whereParts = [];
    const params = [];
    const rawSearch = (req.query.search || '').toString().trim();
    if (rawSearch) {
      const likeTerm = `%${rawSearch}%`;
      params.push(likeTerm);
      const likeIdx = params.length;
      // Match on names in joined tables; joins follow below in the main query
      whereParts.push(
        `(COALESCE(c.client_name, c.company_name, '') ILIKE $${likeIdx} OR COALESCE(m.customer_name, '') ILIKE $${likeIdx})`
      );

      const numericTerm = rawSearch.replace(/\s+/g, '');
      if (numericTerm) {
        params.push(numericTerm);
        const numIdx = params.length;
        whereParts.push(`(CAST(cmc.client_id AS TEXT) = $${numIdx} OR CAST(cmc.medad_customer_id AS TEXT) = $${numIdx})`);
      }
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' OR ')}` : '';
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const linkedQuery = `
      SELECT
        cmc.*,
        COALESCE(c.client_name, c.company_name) AS app_client_name,
        c.company_name AS app_company_name,
        c.phone_number AS app_phone,
        c.tax_number AS app_tax,
        COALESCE(m.customer_name, cmc.medad_customer_id::text) AS medad_customer_name,
        m.vat_no AS medad_vat,
        m.phone AS medad_phone,
        m.balance AS medad_balance,
        m.credit_limit AS medad_credit_limit,
        m.credit_days AS medad_credit_days,
        m.salesman_name AS medad_salesman
      FROM client_medad_customers cmc
      LEFT JOIN clients c ON CAST(c.id AS TEXT) = CAST(cmc.client_id AS TEXT)
      LEFT JOIN medad_customers_import m ON CAST(m.medad_customer_id AS TEXT) = CAST(cmc.medad_customer_id AS TEXT)
      ${whereClause}
      ORDER BY cmc.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const linkedResult = await executeWithRetry(() =>
      withTimeout(
        client.query(linkedQuery, [...params, limit, offset]),
        10000
      )
    );

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM client_medad_customers cmc
      LEFT JOIN clients c ON CAST(c.id AS TEXT) = CAST(cmc.client_id AS TEXT)
      LEFT JOIN medad_customers_import m ON CAST(m.medad_customer_id AS TEXT) = CAST(cmc.medad_customer_id AS TEXT)
      ${whereClause}
    `;

    const countResult = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, params), 10000)
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

// POST /api/medad/links
router.post('/medad/links', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const clientId = req.body.clientId ?? req.body.client_id;
    const medadCustomerId = req.body.medadCustomerId ?? req.body.medad_customer_id;
    const vatNo = req.body.vatNo ?? req.body.vat_no;
    const branchName = req.body.branchName ?? req.body.branch_name ?? null;
    const salesmanIncoming = req.body.salesmanName ?? req.body.salesman_name ?? req.body.salesmanId ?? req.body.salesman_id ?? null;
    const salesmanId = salesmanIncoming;
    const salesmanName = salesmanIncoming;
    const isDefault = Boolean(req.body.isDefault ?? req.body.is_default ?? false);
    const address1 = req.body.address1 ?? req.body.address_1 ?? null;
    const address2 = req.body.address2 ?? req.body.address_2 ?? null;
    const city = req.body.city ?? null;
    const region = req.body.region ?? req.body.citySubdivisionName ?? null;
    const phone = req.body.phone ?? req.body.contact1Phone ?? null;
    const vatType = req.body.vatType ?? req.body.vat_type ?? null;
    const warehouseNo = req.body.warehouseNo ?? req.body.warehouse_no ?? null;

    if (!clientId || !medadCustomerId) {
      return res.status(400).json({ error: 'clientId and medadCustomerId are required' });
    }

    const existsQuery = `
      SELECT id FROM client_medad_customers
      WHERE CAST(medad_customer_id AS TEXT) = CAST($1 AS TEXT)
         OR (CAST(client_id AS TEXT) = CAST($2 AS TEXT) AND CAST(medad_customer_id AS TEXT) = CAST($1 AS TEXT))
      LIMIT 1
    `;

    const existsResult = await executeWithRetry(() =>
      withTimeout(client.query(existsQuery, [medadCustomerId, clientId]), 10000)
    );

    if (existsResult.rows.length > 0) {
      return res.status(409).json({ error: 'Link already exists for this Medad customer' });
    }

    const insertQuery = `
      INSERT INTO client_medad_customers (
        client_id,
        medad_customer_id,
        vat_no,
        branch_name,
        salesman_id,
        salesman_name,
        is_default,
        address1,
        address2,
        city,
        region,
        phone,
        vat_type,
        warehouse_no
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const insertResult = await executeWithRetry(() =>
      withTimeout(
        client.query(insertQuery, [
          clientId,
          medadCustomerId,
          vatNo || null,
          branchName,
          salesmanId,
          salesmanName,
          isDefault,
          address1,
          address2,
          city,
          region,
          phone,
          vatType,
          warehouseNo,
        ]),
        10000
      )
    );

    return res.status(201).json({ link: insertResult.rows[0] });
  } finally {
    client.release();
  }
}));

export default router;
