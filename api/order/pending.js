import express from 'express';
import moment from 'moment-timezone';
import admin from '../../firebase-init.js';
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



router.get('/orders/manager/pending-count', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `%${req.query.query || ''}%`;

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE orders.manageraccept = 'pending'
    `;

const result = await client.query(countQuery);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ pendingOrdersCount: count });
  } catch (error) {
    console.error('Error fetching pending orders count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});




router.get('/orders/supervisor/pending-count', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `%${req.query.query || ''}%`;

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE orders.supervisoraccept = 'pending'
    `;

const result = await client.query(countQuery);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ pendingOrdersCount: count });
  } catch (error) {
    console.error('Error fetching pending orders count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});





router.get('/orders/storekeeper/pending-count', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `%${req.query.query || ''}%`;

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE orders.storekeeperaccept = 'pending'
    `;

const result = await client.query(countQuery);
    const count = parseInt(result.rows[0].count, 10);

    res.status(200).json({ pendingOrdersCount: count });
  } catch (error) {
    console.error('Error fetching pending orders count:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});



export default router;