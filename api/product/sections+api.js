import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

/**
 * POST /sections
 * Create a new section
 */
router.post('/sections', asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Section name is required' });
    }

    const insertQuery = `
      INSERT INTO sections (name)
      VALUES ($1)
      RETURNING *;
    `;

    const result = await client.query(insertQuery, [name]);

    res.status(201).json({ message: 'Section created successfully', section: result.rows[0] });
  } catch (err) {
    console.error('Error creating section:', err);
    res.status(500).json({ error: 'Failed to create section' });
  } finally {
    client.release();
  }
}));

/**
 * GET /sections
 * Get all sections
 */
router.get('/sections', asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT * FROM sections
      ORDER BY created_at DESC;
    `);

    res.status(200).json({ sections: result.rows });
  } catch (err) {
    console.error('Error fetching sections:', err);
    res.status(500).json({ error: 'Failed to fetch sections' });
  } finally {
    client.release();
  }
}));

/**
 * GET /sections/:id
 * Get single section
 */
router.get('/sections/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    const result = await client.query(
      'SELECT * FROM sections WHERE id = $1;',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching section:', err);
    res.status(500).json({ error: 'Failed to fetch section' });
  } finally {
    client.release();
  }
}));

/**
 * PUT /sections/:id
 * Update section
 */
router.put('/sections/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  const { name } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Section name is required' });
    }

    const result = await client.query(
      'UPDATE sections SET name = $1 WHERE id = $2 RETURNING *;',
      [name, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }

    res.status(200).json({ message: 'Section updated successfully', section: result.rows[0] });
  } catch (err) {
    console.error('Error updating section:', err);
    res.status(500).json({ error: 'Failed to update section' });
  } finally {
    client.release();
  }
}));

/**
 * DELETE /sections/:id
 * Delete section
 */
router.delete('/sections/:id', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    const result = await client.query(
      'DELETE FROM sections WHERE id = $1 RETURNING *;',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Section not found' });
    }

    res.status(200).json({ message: 'Section deleted successfully' });
  } catch (err) {
    console.error('Error deleting section:', err);
    res.status(500).json({ error: 'Failed to delete section' });
  } finally {
    client.release();
  }
}));

export default router;
