import express from 'express';
import { pool, executeWithRetry, withTimeout } from '@/lib/db'; // or your pool helpers

const router = express.Router();

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
