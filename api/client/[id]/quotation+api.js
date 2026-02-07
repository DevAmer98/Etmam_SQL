import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../../utils/asyncHandler.js';

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

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

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

// GET /api/clients/:id/quotations
router.get('/clients/:id/quotations', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Missing client ID' });
  }

  const client = await pool.connect();
  try {
    const quotationsQuery = `
      SELECT
        id,
        quotation_number,
        custom_id,
        delivery_date,
        delivery_type,
        notes,
        status,
        total_price,
        created_at,
        updated_at
      FROM quotations
      WHERE client_id = $1
      ORDER BY created_at DESC
    `;

    const quotationsResult = await executeWithRetry(() =>
      withTimeout(client.query(quotationsQuery, [id]), 10000)
    );

    const quotations = quotationsResult.rows;

    if (!quotations || quotations.length === 0) {
      return res.status(404).json({ message: 'No quotations found for this client' });
    }

    const quotationsWithProducts = [];
    for (const quotation of quotations) {
      const productsQuery = `
        SELECT
          id,
          description,
          quantity,
          price,
          vat,
          subtotal
        FROM quotation_products
        WHERE quotation_id = $1
      `;

      const productsResult = await executeWithRetry(() =>
        withTimeout(client.query(productsQuery, [quotation.id]), 10000)
      );

      quotationsWithProducts.push({
        ...quotation,
        products: productsResult.rows || [],
      });
    }

    return res.status(200).json({
      clientId: id,
      quotationCount: quotationsWithProducts.length,
      quotations: quotationsWithProducts,
    });
  } catch (error) {
    console.error('Error fetching client quotations:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      details: error.message,
    });
  } finally {
    client.release();
  }
}));

export default router;
