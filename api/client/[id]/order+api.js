import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../../utils/asyncHandler.js'; // Adjust path if needed

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Retry wrapper
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

// Timeout wrapper
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Initial DB connectivity test
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('✅ DB connection successful:', res.rows);
  } catch (error) {
    console.error('❌ DB connection failed:', error);
  }
})();

// GET /api/clients/:id/orders
router.get('/clients/:id/orders', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing client ID' });
  }

  const client = await pool.connect();
  try {
    const ordersQuery = `
      SELECT 
        id,
        order_number,
        custom_id,
        delivery_date,
        delivery_type,
        notes,
        status,
        total_price,
        created_at,
        updated_at
      FROM orders
      WHERE client_id = $1
      ORDER BY created_at DESC
    `;

    const ordersResult = await executeWithRetry(() =>
      withTimeout(client.query(ordersQuery, [id]), 10000)
    );

    const orders = ordersResult.rows;

    if (!orders || orders.length === 0) {
      return res.status(404).json({ message: 'No orders found for this client' });
    }

    const ordersWithProducts = [];
    for (const order of orders) {
      const productsQuery = `
        SELECT
          id,
          description,
          quantity,
          price,
          vat,
          subtotal
        FROM order_products
        WHERE order_id = $1
      `;

      const productsResult = await executeWithRetry(() =>
        withTimeout(client.query(productsQuery, [order.id]), 10000)
      );

      ordersWithProducts.push({
        ...order,
        products: productsResult.rows || [],
      });
    }

    return res.status(200).json({
      clientId: id,
      orderCount: ordersWithProducts.length,
      orders: ordersWithProducts,
    });
  } catch (error) {
    console.error('Error fetching client orders:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
