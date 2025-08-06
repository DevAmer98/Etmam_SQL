import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// Util functions...
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

router.post('/suppliers', asyncHandler(async (req, res) => {
  const supplier = await pool.connect();
  try {
    const {
      company_name, username, supplier_name,
      phone_number, tax_number, CR,
    } = req.body;

    if (
      !company_name || !supplier_name || 
      !phone_number || !CR || !tax_number || !username
    ) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const checkQuery = `SELECT 1 FROM suppliers WHERE company_name = $1 LIMIT 1;`;
    const existingSupplier = await supplier.query(checkQuery, [company_name]);

    if (existingSupplier.rows.length > 0) {
      return res.status(409).json({
        error: 'المورد موجود بالفعل بنفس رقم الهاتف أو الاسم في الشركة'
      });
    }

    const insertQuery = `
      INSERT INTO suppliers (
        company_name, username, supplier_name, phone_number,
        tax_number, CR
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [
      company_name, username, supplier_name, phone_number,
      tax_number || null, CR || null
    ];

    const response = await executeWithRetry(() =>
      withTimeout(supplier.query(insertQuery, values), 10000)
    );

    res.status(201).json({ data: response.rows[0] });
  } finally {
    supplier.release();
  }
}));

// GET /api/clients
router.get('/suppliers', asyncHandler(async (req, res) => {
  const supplier = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const searchQuery = `%${req.query.search || ''}%`;
    const offset = (page - 1) * limit;

    const countQuery = `
      SELECT COUNT(*) FROM suppliers
      WHERE company_name ILIKE $1 OR supplier_name ILIKE $1;
    `;
    const totalSuppliers = await executeWithRetry(() =>
      withTimeout(supplier.query(countQuery, [searchQuery]), 10000)
    );

    const selectQuery = `
      SELECT * FROM suppliers
      WHERE company_name ILIKE $1 OR supplier_name ILIKE $1
      ORDER BY supplier_name
      LIMIT $2 OFFSET $3;
    `;
    const result = await executeWithRetry(() =>
      withTimeout(supplier.query(selectQuery, [searchQuery, limit, offset]), 10000)
    );

    const total = parseInt(totalSuppliers.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      suppliers: result.rows,
      total,
      page,
      totalPages,
      limit,
    });
  } finally {
    supplier.release();
  }
}));

export default router;
