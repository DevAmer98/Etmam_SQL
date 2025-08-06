import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// GET /api/products/:id
router.get('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    const result = await client.query(`
      SELECT p.*, s.supplier_name, s.company_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.id = $1;
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('GET error:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  } finally {
    client.release();
  }
}));

// PUT /api/products/:id
router.put('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  const { name, sku, code, comment } = req.body;

  try {
    const result = await client.query(`
      UPDATE products
      SET name = $1, sku = $2, code = $3, comment = $4
      WHERE id = $5
      RETURNING *;
    `, [name, sku, code || null, comment || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.status(200).json({ message: 'Product updated', product: result.rows[0] });
  } catch (err) {
    console.error('PUT error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  } finally {
    client.release();
  }
}));

// DELETE /api/products/:id
router.delete('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    const result = await client.query(`DELETE FROM products WHERE id = $1 RETURNING *;`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.status(200).json({ message: 'Product deleted' });
  } catch (err) {
    console.error('DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  } finally {
    client.release();
  }
}));

export default router;
