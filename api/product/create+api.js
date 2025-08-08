import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

router.post('/products', asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    const { supplier_id, name, code, quantity, comment } = req.body;

    if (!supplier_id || !name || !code) {
      return res.status(400).json({ error: 'supplier_id, name, and code are required' });
    }

    const insertQuery = `
      INSERT INTO products (supplier_id, name, quantity, code, comment)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const result = await client.query(insertQuery, [
      supplier_id,
      name,
      quantity,
      code || null,
      comment || null
    ]);

    res.status(201).json({ message: 'Product created successfully', product: result.rows[0] });
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: 'Failed to create product' });
  } finally {
    client.release();
  }
}));


router.get('/products', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    const searchQuery = `%${search}%`;

    const countQuery = `
      SELECT COUNT(*) FROM products
      WHERE name ILIKE $1 OR code ILIKE $1;
    `;
    const countResult = await client.query(countQuery, [searchQuery]);
    const total = parseInt(countResult.rows[0].count, 10);

    const selectQuery = `
      SELECT p.*, s.supplier_name, s.company_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.name ILIKE $1 OR p.code ILIKE $1
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3;
    `;
    const productsResult = await client.query(selectQuery, [searchQuery, limit, offset]);

    res.status(200).json({
      products: productsResult.rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  } finally {
    client.release();
  }
}));


export default router;



