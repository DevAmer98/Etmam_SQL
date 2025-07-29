import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

router.use(express.json());

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

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



// GET /api/quotations/exported-false-count?salesRep=username
router.get('/quotations/exported-false-count', async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Missing salesRep username' });
  }

  try {
    const query = `
      SELECT COUNT(*) FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE quotations.exported = 'FALSE' AND clients.username = $1
    `;

    const result = await pool.query(query, [username]);
    const count = parseInt(result.rows[0].count, 10);

    return res.status(200).json({ unexportedCount: count });
  } catch (error) {
    console.error('Error fetching unexported count:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});



export default router;
