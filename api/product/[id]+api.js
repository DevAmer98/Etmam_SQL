import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';




const PRICING_COLUMNS = [
  'price_1_5',
  'price_6_10',
  'price_11_20',
  'price_20_plus',
  'price_1_49',
  'price_50_99',
  'price_100_499',
  'price_500_plus',
];



const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// GET /api/products/:id
router.get('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    const result = await client.query(`
      SELECT p.*,
             s.supplier_name, s.company_name,
             sec.name AS section_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN sections  sec ON p.section_id = sec.id
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

/*
router.put('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  // Accept these fields; ignore unknowns
  const { name, quantity, code, comment, supplier_id, section_id } = req.body ?? {};

  try {
    // Get current product
    const cur = await client.query(`SELECT quantity FROM products WHERE id = $1`, [id]);
    if (cur.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const currentQty = Number(cur.rows[0].quantity ?? 0);

    // If client provided quantity, enforce "increase-only" here
    let nextQty = currentQty;
    if (quantity !== undefined && quantity !== null) {
      const num = Number(quantity);
      if (Number.isNaN(num) || num < 0) {
        return res.status(400).json({ error: 'Quantity must be a non-negative number' });
      }
      if (num < currentQty) {
        return res.status(403).json({
          error: 'Quantity reductions are not allowed in this endpoint. Use the Orders flow.'
        });
      }
      nextQty = num;
    }

    const result = await client.query(
      `
      UPDATE products
      SET
        name        = COALESCE($1, name),
        quantity    = $2,
        code        = COALESCE($3, code),
        comment     = COALESCE($4, comment),
        supplier_id = COALESCE($5, supplier_id),
        section_id  = COALESCE($6, section_id)
      WHERE id = $7
      RETURNING *;
      `,
      [
        name ?? null,          // allow name change if you want
        nextQty,
        code ?? null,
        comment ?? null,
        supplier_id ?? null,
        section_id ?? null,
        id
      ]
    );

    res.status(200).json({ message: 'Product updated', product: result.rows[0] });
  } catch (err) {
    console.error('PUT error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  } finally {
    client.release();
  }
}));
*/


// PUT /api/products/:id
router.put('/products/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  const {
    name, quantity, code, comment, supplier_id, section_id,
    // allow any subset of pricing fields
    price_1_5, price_6_10, price_11_20, price_20_plus,
    price_1_49, price_50_99, price_100_499, price_500_plus,
  } = req.body ?? {};

  try {
    // current qty to enforce increase-only rule
    const cur = await client.query(`SELECT quantity FROM products WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const currentQty = Number(cur.rows[0].quantity ?? 0);

    // validate & normalize quantity
    let nextQty = currentQty;
    if (quantity !== undefined && quantity !== null) {
      const num = Number(quantity);
      if (Number.isNaN(num) || num < 0) return res.status(400).json({ error: 'Quantity must be a non-negative number' });
      if (num < currentQty) {
        return res.status(403).json({ error: 'Quantity reductions are not allowed in this endpoint. Use the Orders flow.' });
      }
      nextQty = num;
    }

    // collect regular updatable fields
    const sets = [
      ['name', name],
      ['quantity', nextQty],
      ['code', code],
      ['comment', comment],
      ['supplier_id', supplier_id],
      ['section_id', section_id],
    ];

    // collect pricing fields provided in body, validate as non-negative numbers
    const body = req.body ?? {};
    PRICING_COLUMNS.forEach(col => {
      if (Object.prototype.hasOwnProperty.call(body, col)) {
        const val = body[col];
        if (val === null || val === '') {
          // treat empty as 0 (optional: or skip updating)
          sets.push([col, 0]);
        } else {
          const n = Number(val);
          if (Number.isNaN(n) || n < 0) {
            throw Object.assign(new Error(`${col} must be a non-negative number`), { status: 400 });
          }
          sets.push([col, n]);
        }
      }
    });

    // build dynamic SQL SET list with placeholders
    let idx = 1;
    const setSql = sets
      .filter(([_, v]) => v !== undefined) // only include provided fields
      .map(([k, _]) => `${k} = $${idx++}`)
      .join(', ');
    const values = sets.filter(([_, v]) => v !== undefined).map(([_, v]) => v);

    if (!setSql) return res.status(400).json({ error: 'No valid fields to update' });

    const result = await client.query(
      `UPDATE products SET ${setSql} WHERE id = $${idx} RETURNING *;`,
      [...values, id]
    );

    res.status(200).json({ message: 'Product updated', product: result.rows[0] });
  } catch (err) {
    const status = err.status || 500;
    console.error('PUT error:', err);
    res.status(status).json({ error: err.message || 'Failed to update product' });
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
