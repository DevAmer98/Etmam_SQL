import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

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

// Shared filter to exclude completed/rejected quotations
const baseFilter = `
  status NOT IN ('rejected')
`;

// Manager
router.get('/quotations/manager/pending-count', async (req, res) => {
  const client = await pool.connect();
  try {
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE quotations.manageraccept = 'pending'
        AND ${baseFilter}
    `;

    const result = await client.query(countQuery);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ pendingQuotationsCount: count });
  } catch (error) {
    console.error('Error fetching pending quotations count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Supervisor
router.get('/quotations/supervisor/pending-count', async (req, res) => {
  const client = await pool.connect();
  try {
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    const whereParts = [
      "quotations.supervisoraccept = 'pending'",
      baseFilter,
    ];
    const params = [];
    if (username) {
      params.push(username);
      whereParts.push(
        `(LOWER(TRIM(quotations.username)) = LOWER(TRIM($1)) OR LOWER(TRIM(clients.username)) = LOWER(TRIM($1)))`
      );
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      ${whereClause}
    `;

    const result = await client.query(countQuery, params);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ pendingQuotationsCount: count });
  } catch (error) {
    console.error('Error fetching pending quotations count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
