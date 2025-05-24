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



router.post('/quotations/supervisor', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, username, supervisor_id, delivery_date, delivery_type, products, notes, condition = 'نقدي - كاش', status = 'not Delivered' } = req.body;

    // Validate required fields
    if (!client_id || !username || !supervisor_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      throw new Error('Missing required fields');
    }

    // Format delivery date
    const formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
    const customId = await generateCustomId(client); // Generate custom_id without RevX

    // Insert main quotation
    const insertQuery = `
      INSERT INTO quotations (client_id, username, supervisor_id, delivery_date, delivery_type, notes, status, total_price, total_vat, total_subtotal, custom_id, condition)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
    `;
    const insertParams = [client_id, username, supervisor_id, formattedDate, delivery_type, notes || null, status, 0, 0, 0, customId, condition];
    const quotationResult = await client.query(insertQuery, insertParams);
    const quotationId = quotationResult.rows[0].id;

    let totalPrice = 0, totalVat = 0, totalSubtotal = 0;
    // Insert products
    for (const product of products) {
      const { section, type, description, quantity, price } = product;
      if (!section || !type || !quantity || !price) {
        throw new Error('Missing product details or price');
      }
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice)) { throw new Error('Invalid price format'); }
      const vat = numericPrice * 0.15;
      const subtotal = numericPrice + vat;
      totalPrice += numericPrice * quantity;
      totalVat += vat * quantity;
      totalSubtotal += subtotal * quantity;
      await client.query(
        `INSERT INTO quotation_products (quotation_id, section, type, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [quotationId, section, type, description, quantity, numericPrice, vat, subtotal]
      );
    }

    // Update the quotation totals
    await client.query(
      `UPDATE quotations SET total_price = $1, total_vat = $2, total_subtotal = $3 WHERE id = $4`,
      [totalPrice, totalVat, totalSubtotal, quotationId]
    );

    await client.query('COMMIT');
    //await sendNotificationToSupervisor(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');
    await sendNotificationToManager(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');

    return res.status(201).json({
      quotationId,
      customId,
      status: 'success',
      totalPrice,
      totalVat,
      totalSubtotal,
      condition,
    });
  } catch (error) {
    console.error('Transaction Error:', error);
    await client.query('ROLLBACK');
    return res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});


router.get('/quotations/supervisor', async (req, res) => {
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
        ? `(quotations.status = $2 OR quotations.supervisoraccept = $2)`
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
        ? `(quotations.status = $4 OR quotations.supervisoraccept = $4)`
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