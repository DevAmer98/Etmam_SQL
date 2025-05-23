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

// Function to generate custom ID
const generateCustomId = async (client) => {
  const year = new Date().getFullYear();
  const result = await client.query(
    `SELECT MAX(SUBSTRING(custom_id FROM 10)::int) AS last_id 
     FROM quotations 
     WHERE custom_id LIKE $1`,
    [`NPQ-${year}-%`]
  );
  const lastId = result.rows[0].last_id || 0;
  const newId = `NPQ-${year}-${String(lastId + 1).padStart(5, '0')}`;
  return newId;
};

// POST endpoint to create a quotation
// POST endpoint to create a quotation
router.post('/quotations', async (req, res) => {
  const client = await pool.connect();
  try {
    await executeWithRetry(async () => {
      await client.query('BEGIN'); // Start transaction

      const {
        client_id,
        delivery_date,
        delivery_type,
        products,
        notes,
        status = 'not Delivered',
        storekeeperaccept = 'pending',
        supervisoraccept = 'pending',
        manageraccept = 'pending',
      } = req.body;

      // Debugging: Log the request body
      console.log('Request Body:', req.body);

      // Validate required fields
      if (!client_id || !delivery_date || !delivery_type || !products || products.length === 0) {
        await client.query('ROLLBACK'); // Rollback if validation fails
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Generate custom ID
      const customId = await generateCustomId(client);

      // Insert quotation
      const quotationResult = await client.query(
        `INSERT INTO quotations (client_id, delivery_date, delivery_type, notes, status, storekeeperaccept, supervisoraccept, manageraccept, actual_delivery_date, total_price, total_vat, total_subtotal, custom_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          client_id,
          delivery_date,
          delivery_type,
          notes || null,
          status,
          storekeeperaccept,
          supervisoraccept,
          manageraccept,
          null, // actual_delivery_date
          0, // total_price (initial value)
          0, // total_vat (initial value)
          0, // total_subtotal (initial value)
          customId, // custom_id
        ]
      );

      const quotationId = quotationResult.rows[0].id;
      let totalPrice = 0;
      let totalVat = 0;
      let totalSubtotal = 0;

      // Insert products and calculate VAT and subtotal for each row
      for (const product of products) {
        const { section, type, description, quantity, price } = product;

        // Validate product fields
        if (!section || !type || !quantity || !price) {
          await client.query('ROLLBACK'); // Rollback if product validation fails
          return res.status(400).json({ error: 'Missing product details or price' });
        }

        const numericPrice = parseFloat(price);
        if (isNaN(numericPrice)) {
          await client.query('ROLLBACK'); // Rollback if price is invalid
          return res.status(400).json({ error: 'Invalid price format' });
        }

        // Calculate VAT and subtotal for the current product row
        const totalPriceForProduct = numericPrice * quantity; // Total price for the quantity
        const vat = totalPriceForProduct * 0.15; // VAT is 15% of the total price for the quantity
        const subtotal = totalPriceForProduct + vat; // Subtotal is total price + VAT

        // Debugging: Log the values
        console.log({
          productId: product.id,
          numericPrice,
          quantity,
          totalPriceForProduct,
          vat,
          subtotal,
        });

        // Update totals for the entire quotation
        totalPrice += totalPriceForProduct; // Total price is sum of (price * quantity)
        totalVat += vat; // Total VAT is sum of (VAT * quantity)
        totalSubtotal += subtotal; // Total subtotal is sum of all subtotals

        // Insert the product row with VAT and subtotal
        await client.query(
          `INSERT INTO quotation_products (quotation_id, section, type, description, quantity, price, vat, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [quotationId, section, type, description, quantity, numericPrice, vat, subtotal]
        );
      }

      // Update the quotation with the total price, total VAT, and total subtotal
      await client.query(
        `UPDATE quotations 
         SET total_price = $1, 
             total_vat = $2, 
             total_subtotal = $3 
         WHERE id = $4`,
        [totalPrice, totalVat, totalSubtotal, quotationId]
      );

      await client.query('COMMIT'); // Commit transaction
      return res.status(201).json({
        quotationId,
        customId,
        status: 'success',
        totalPrice,
        totalVat,
        totalSubtotal,
      });
    });
  } catch (error) {
    await client.query('ROLLBACK'); // Rollback on any error
    console.error('Error creating quotation:', error);
    return res.status(500).json({ error: error.message || 'Error creating quotation' });
  } finally {
    client.release(); // Release the client back to the pool
  }
});


router.get('/quotations', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = `%${req.query.query || ''}%`;
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    const hasStatus = status !== 'all';
    const countParams = hasStatus ? [query, status] : [query];
    const countCondition = hasStatus
      ? `(quotations.status = $2 OR quotations.manageraccept = $2)`
      : 'TRUE';

    // COUNT query
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND ${countCondition}
    `;

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Build pagination query
    const baseParams = hasStatus
      ? [limit, offset, query, status]
      : [limit, offset, query];

    const filterCondition = hasStatus
      ? `(quotations.status = $4 OR quotations.manageraccept = $4)`
      : 'TRUE';

    const baseQuery = `
      SELECT 
        quotations.*, 
        clients.client_name AS client_name,
        clients.phone_number AS client_phone,
        clients.company_name AS client_company,
        clients.branch_number AS client_branch,
        clients.tax_number AS client_tax,
        clients.latitude AS client_latitude,
        clients.longitude AS client_longitude,
        clients.street AS client_street,
        clients.city AS client_city,
        clients.region AS client_region
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${filterCondition}
      ORDER BY quotations.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const quotationsResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = quotationsResult.rows;

    return res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching quotations:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching quotations',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});


export default router;