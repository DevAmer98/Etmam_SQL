import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js'; // adjust path as needed

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });


// Utility function to retry database operations
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

// Utility function to add timeout to database queries
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};


router.get('/allClients', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const searchQuery = `%${req.query.search || ''}%`;
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    const offset = (page - 1) * limit;

    const whereParts = [];
    const params = [];
    let idx = 1;
    params.push(searchQuery);
    whereParts.push(`(client_name ILIKE $${idx} OR company_name ILIKE $${idx})`);
    idx += 1;
    if (username) {
      params.push(username);
      whereParts.push(`LOWER(TRIM(username)) = LOWER(TRIM($${idx}))`);
      idx += 1;
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const clientsQuery = `
      SELECT * FROM clients
      ${whereClause}
      ORDER BY client_name
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const clientsResult = await executeWithRetry(() =>
      withTimeout(client.query(clientsQuery, [...params, limit, offset]), 10000)
    );

    const countQuery = `
      SELECT COUNT(*) AS count FROM clients
      ${whereClause}
    `;

    const countResult = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, params), 10000)
    );

    const total = parseInt(countResult.rows[0]?.count || '0', 10);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      clients: clientsResult.rows,
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
