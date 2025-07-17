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



router.get('/quotations/accepted-count', async (req, res) => {
  const client = await pool.connect();
  try {

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM quotations
      JOIN clients ON orders.client_id = clients.id
      WHERE (quotations.manageraccept = 'accepted' AND quotations.supervisoraccept = 'accepted')
    `;

const result = await client.query(countQuery);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ acceptedQuotationsCount: count });
  } catch (error) {
    console.error('Error fetching accepted quotations count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});




export default router;