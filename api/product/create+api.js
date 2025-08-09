import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// POST /products
router.post('/products', asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    const { supplier_id, name, code, quantity = 0, comment, section_id = null } = req.body;

    if (!supplier_id || !name || !code) {
      return res.status(400).json({ error: 'supplier_id, name, and code are required' });
    }

    // ✅ Safeguard: check if section_id exists (if provided)
    if (section_id !== null) {
      const sectionCheck = await client.query(
        'SELECT 1 FROM sections WHERE id = $1',
        [section_id]
      );

      if (sectionCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Invalid section_id provided' });
      }
    }

    const status = quantity === 0 ? 'Out of Stock' : 'Available';

    const insertQuery = `
      INSERT INTO products (supplier_id, name, quantity, code, comment, status, section_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;

    const result = await client.query(insertQuery, [
      supplier_id,
      name,
      quantity,
      code || null,
      comment || null,
      status,
      section_id
    ]);

    res.status(201).json({ message: 'Product created successfully', product: result.rows[0] });
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: 'Failed to create product' });
  } finally {
    client.release();
  }
}));


/*
// GET /products
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
      SELECT 
        p.*, 
        s.supplier_name, 
        s.company_name,
        sec.name AS section_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN sections sec ON p.section_id = sec.id
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
*/



router.get('/products', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const search = (req.query.search || '').toString().trim();
    const sectionIdRaw = req.query.section_id;
    const sectionId = sectionIdRaw ? parseInt(sectionIdRaw as string, 10) : null;

    const offset = (page - 1) * limit;
    const searchQuery = `%${search}%`;

    // Build dynamic WHERE
    const whereParts: string[] = [];
    const params: any[] = [];

    // search by name or code
    if (search) {
      params.push(searchQuery);
      whereParts.push('(p.name ILIKE $' + params.length + ' OR p.code ILIKE $' + params.length + ')');
    }

    // optional section filter
    if (sectionId && !Number.isNaN(sectionId)) {
      params.push(sectionId);
      whereParts.push('p.section_id = $' + params.length);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // COUNT
    const countSql = `
      SELECT COUNT(*) AS count
      FROM products p
      ${whereSql};
    `;
    const countResult = await client.query(countSql, params);
    const total = parseInt(countResult.rows[0].count, 10) || 0;

    // SELECT (join suppliers + sections)
    const selectParams = [...params, limit, offset];
    const selectSql = `
      SELECT 
        p.*,
        s.supplier_name,
        s.company_name,
        sec.name AS section_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN sections  sec ON p.section_id = sec.id
      ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT $${selectParams.length - 1} OFFSET $${selectParams.length};
    `;
    const productsResult = await client.query(selectSql, selectParams);

    res.status(200).json({
      products: productsResult.rows,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
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
