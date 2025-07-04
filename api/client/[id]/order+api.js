import express from 'express';
import pkg from 'pg'; // Import pg library
const { Pool } = pkg; // Destructure Pool

const router = express.Router();

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});

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

// Test database connection
(async () => {
  try {
    const res = await executeWithRetry(() =>
      withTimeout(pool.query('SELECT 1 AS test'), 5000)
    );
    console.log('Database connection successful:', res.rows);
  } catch (error) {
    console.error('Database connection error:', error);
  }
})();

// GET /api/clients/:id/orders
router.get('/clients/:id/orders', async (req, res) => {
  const { id } = req.params;

  if (!id) return res.status(400).json({ error: 'Missing client ID' });

  const client = await pool.connect();
  try {
    const ordersQuery = `
      SELECT 
        orders.id,
        orders.order_number,
        orders.custom_id,
        orders.delivery_date,
        orders.delivery_type,
        orders.notes,
        orders.status,
        orders.total_price,
        orders.created_at,
        orders.updated_at
      FROM orders
      WHERE orders.client_id = $1
      ORDER BY orders.created_at DESC
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
});

export default router;
